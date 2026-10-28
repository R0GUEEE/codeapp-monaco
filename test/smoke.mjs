// Headless end-to-end check for the extension runtime.
//
// It serves the built bundle plus a fixture extension over HTTP (the same shape
// the iOS app uses: <origin>/ext/index.json + <origin>/ext/<id>/...) and then
// drives a real Chromium:
//   1. the editor boots
//   2. window.codeExtensions.load() registers the fixture
//   3. the extension host activates it (imports the module, runs activate())
//   4. a contributed command executes and returns a value
//
// Run with: node test/smoke.mjs
import { createServer } from "node:http";
import { readFile, stat, readdir } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "monaco-textmate.bundle");
const fixtureDir = join(root, "test/fixture");
const fixtureId = "codify.codify-test-extension";

const MIME = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".html": "text/html",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full));
  }
  return out;
}

const files = await walk(fixtureDir);
const manifest = JSON.parse(await readFile(join(fixtureDir, "package.json"), "utf8"));
const nodeFiles = await walk(nodeFixtureDir);
const nodeManifest = JSON.parse(
  await readFile(join(nodeFixtureDir, "package.json"), "utf8")
);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let path = decodeURIComponent(url.pathname);

    if (path === "/ext/index.json") {
      const port = server.address().port;
      const body = JSON.stringify({
        version: 1,
        extensions: [
          {
            id: fixtureId,
            path: `/extensions/${fixtureId}`,
            baseUrl: `http://127.0.0.1:${port}/ext/${fixtureId}`,
            files,
            manifest,
            enabled: true,
            source: "fixture",
          },
        ],
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }

    const served = [
      { id: fixtureId, dir: fixtureDir },
      { id: nodeFixtureId, dir: nodeFixtureDir },
    ].find((extension) => path.startsWith(`/ext/${extension.id}/`));
    if (served) {
      const rel = path.slice(`/ext/${served.id}/`.length);
      const file = normalize(join(served.dir, rel));
      if (!file.startsWith(served.dir)) throw new Error("traversal");
      const data = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
      });
      res.end(data);
      return;
    }

    if (path === "/") path = "/index.html";
    const file = normalize(join(distDir, path));
    if (!file.startsWith(distDir)) throw new Error("traversal");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
console.log(`serving ${distDir} on http://127.0.0.1:${port}`);

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleLines = [];
page.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
page.on("pageerror", (err) => consoleLines.push(`pageerror: ${err.message}`));

await page.addInitScript(() => {
  // Pretend to be the iOS host so editor code can post events.
  window.__nativeEvents = [];
  window.webkit = {
    messageHandlers: {
      toggleMessageHandler: {
        postMessage: (message) => window.__nativeEvents.push(message),
      },
    },
  };
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });

try {
  await page.waitForFunction(() => !!window.codeExtensions, null, { timeout: 120000 });
  check(true, "editor booted and extension bridge installed");

  const result = await page.evaluate(() => window.codeExtensions.load());
  check(
    result.loaded.includes("codify.codify-test-extension"),
    "fixture registered with extension host",
    JSON.stringify(result)
  );
  check(
    !result.loaded.includes("codify.node-only-test-extension"),
    "node-only extension is not registered",
    JSON.stringify(result.loaded)
  );

  await page.waitForFunction(() => globalThis.__fixtureActivated === true, null, {
    timeout: 120000,
  });
  check(true, "extension activated (activate() ran)");

  const hello = await page.evaluate(() =>
    window.codeExtensions.executeCommand("codify.test.hello")
  );
  check(hello === "hello-from-extension", "contributed command returned value", String(hello));

  const state = await page.evaluate(() =>
    window.codeExtensions.executeCommand("codify.test.state")
  );
  check(state?.activated === true, "extension API available inside extension", JSON.stringify(state));

  const commands = await page.evaluate(() => window.codeExtensions.listCommands());
  check(
    commands.some((c) => c.command === "codify.test.hello"),
    "contributed commands are enumerable for the native palette",
    JSON.stringify(commands)
  );

  const events = await page.evaluate(() => window.__nativeEvents);
  check(
    events.some((e) => e.Event === "Extension Ready" && e.id === "codify.codify-test-extension"),
    "native host notified about the ready extension"
  );

  const ready = events.find(
    (e) => e.Event === "Extension Ready" && e.id === "codify.codify-test-extension"
  );
  check(
    ready?.compat?.status === "supported",
    "ready event carries the compatibility summary",
    JSON.stringify(ready?.compat)
  );

  const rejected = events.filter((e) => e.id === "codify.node-only-test-extension");
  check(
    rejected.some((e) => e.Event === "Extension Error" && e.code === "node-entry-only"),
    "node-only extension rejected with a reason code",
    JSON.stringify(rejected)
  );

  const listed = await page.evaluate(() => window.codeExtensions.list());
  const listedFixture = listed.find((e) => e.id === "codify.codify-test-extension");
  check(
    listedFixture?.compat?.status === "supported" &&
      listedFixture.compat.kind === "web",
    "list() exposes the compatibility report",
    JSON.stringify(listedFixture?.compat)
  );
} catch (e) {
  check(false, "smoke test threw", e instanceof Error ? e.message : String(e));
}

console.log("\n--- page console (filtered) ---");
for (const line of consoleLines.filter((l) => /extension|error|fail/i.test(l)).slice(-40)) {
  console.log(line);
}

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
