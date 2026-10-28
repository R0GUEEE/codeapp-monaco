/**
 * Unit tests for the extension compatibility engine.
 *
 * Run with: npm run test:unit   (vite-node executes the TypeScript directly)
 */
import assert from "node:assert/strict";
import {
  SUPPORTED_VSCODE_ENGINE,
  classifyExtension,
  describeReport,
  primaryReason,
  statusLabel,
  collectNodeApiUsage,
  detectNativeModules,
  orderByDependencies,
  parseVersion,
  satisfies,
} from "../src/extensionCompat";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// --- semver subset ---------------------------------------------------------

check("parseVersion parses partials", () => {
  assert.deepEqual(parseVersion("1.83"), { major: 1, minor: 83, patch: 0 });
  assert.deepEqual(parseVersion("^1.83.4"), { major: 1, minor: 83, patch: 4 });
  assert.equal(parseVersion("not-a-version"), undefined);
});

check("embedded VS Code version matches monaco-vscode-api 6.0.3", () => {
  assert.equal(SUPPORTED_VSCODE_ENGINE, "1.90.2");
});

check("satisfies handles caret / tilde / comparators", () => {
  assert.equal(satisfies("^1.83.0", SUPPORTED_VSCODE_ENGINE), true);
  assert.equal(satisfies("^1.90.0", SUPPORTED_VSCODE_ENGINE), true);
  assert.equal(satisfies("^1.96.0", SUPPORTED_VSCODE_ENGINE), false);
  assert.equal(satisfies("~1.83.2", "1.83.9"), true);
  assert.equal(satisfies("~1.83.2", "1.84.0"), false);
  assert.equal(satisfies(">=1.60 <2.0", "1.83.0"), true);
  assert.equal(satisfies(">=1.60 <2.0", "2.0.0"), false);
  assert.equal(satisfies("^1.70.0 || ^1.90.0", "1.83.0"), true);
  assert.equal(satisfies("1.83", "1.83.7"), true);
});

// --- static inspection -----------------------------------------------------

check("collectNodeApiUsage finds require/import forms", () => {
  const source = `
    const fs = require("fs");
    import { join } from "node:path";
    const os = await import('os');
    const local = require("./local");
    const p = require("vscode");
  `;
  assert.deepEqual(collectNodeApiUsage(source), ["fs", "os", "path"]);
});

check("detectNativeModules", () => {
  assert.equal(detectNativeModules('require("./build/pty.node")'), true);
  assert.equal(detectNativeModules("process.dlopen(module, x)"), true);
  assert.equal(detectNativeModules('require("./extension.js")'), false);
});

// --- classification --------------------------------------------------------

const baseManifest = {
  name: "demo",
  publisher: "acme",
  version: "1.0.0",
  engines: { vscode: "^1.83.0" },
  browser: "./dist/extension.js",
};

check("web extension with existing entry is supported", () => {
  const report = classifyExtension(baseManifest, {
    files: ["package.json", "dist/extension.js"],
    installed: ["acme.demo"],
  });
  assert.equal(report.status, "supported");
  assert.equal(report.kind, "web");
  assert.equal(report.entryPoint, "dist/extension.js");
  assert.deepEqual(report.reasons, []);
});

check("node-only extension is unsupported with a code", () => {
  const report = classifyExtension(
    {
      name: "node-only",
      publisher: "acme",
      version: "1.0.0",
      main: "./out/extension.js",
    },
    { files: ["package.json", "out/extension.js"] }
  );
  assert.equal(report.status, "unsupported");
  assert.equal(report.kind, "node");
  assert.equal(report.reasons[0].code, "node-entry-only");
});

check("declarative themes are supported without code", () => {
  const report = classifyExtension({
    name: "theme",
    publisher: "acme",
    version: "1.0.0",
    contributes: { themes: [{ label: "Acme", uiTheme: "vs-dark", path: "t.json" }] },
  });
  assert.equal(report.status, "supported");
  assert.equal(report.kind, "declarative");
  assert.equal(report.reasons[0].code, "declarative-only");
});

check("missing browser entry file is unsupported", () => {
  const report = classifyExtension(baseManifest, {
    files: ["package.json"],
  });
  assert.equal(report.status, "unsupported");
  assert.equal(report.reasons.at(-1)?.code, "missing-browser-entry");
});

check("newer engine range downgrades to limited but still loads", () => {
  const report = classifyExtension(
    { ...baseManifest, engines: { vscode: "^1.96.0" } },
    { files: ["package.json", "dist/extension.js"] }
  );
  assert.equal(report.status, "limited");
  assert.ok(report.reasons.some((reason) => reason.code === "engine-newer"));
});

check("blocking Node built-ins are reported as limited", () => {
  const report = classifyExtension(baseManifest, {
    files: ["package.json", "dist/extension.js"],
    entrySource: 'const fs = require("fs"); const path = require("path");',
  });
  assert.equal(report.status, "limited");
  assert.deepEqual(report.nodeModules, ["fs", "path"]);
  const reason = report.reasons.find((r) => r.code === "node-api-usage");
  assert.match(reason?.message ?? "", /cannot provide \(fs\)/);
});

check("missing extension dependency is unsupported", () => {
  const report = classifyExtension(
    { ...baseManifest, extensionDependencies: ["acme.core"] },
    { files: ["package.json", "dist/extension.js"], installed: ["acme.demo"] }
  );
  assert.equal(report.status, "unsupported");
  assert.deepEqual(report.missingDependencies, ["acme.core"]);
  assert.equal(report.reasons.at(-1)?.code, "missing-dependency");
});

// --- dependency ordering ---------------------------------------------------

const entries = [
  { id: "acme.app", manifest: { extensionDependencies: ["acme.core"] } },
  { id: "acme.core", manifest: {} },
  { id: "acme.extra", manifest: {} },
];

check("dependencies are ordered before dependents", () => {
  const { order, cycles } = orderByDependencies(entries);
  assert.deepEqual(cycles, []);
  const ids = order.map((entry) => entry.id);
  assert.ok(ids.indexOf("acme.core") < ids.indexOf("acme.app"));
});

check("cycles are reported and annotated", () => {
  const cyclic = [
    { id: "a.one", manifest: { extensionDependencies: ["a.two"] } },
    { id: "a.two", manifest: { extensionDependencies: ["a.one"] } },
  ];
  const { cycles, reports } = orderByDependencies(cyclic);
  assert.ok(cycles.length > 0);
  assert.ok(
    reports.every((report) =>
      report.reasons.some((reason) => reason.code === "dependency-cycle")
    )
  );
});

// --- presentation helpers --------------------------------------------------

check("primaryReason prefers the blocking reason", () => {
  const report = classifyExtension(
    {
      ...baseManifest,
      engines: { vscode: "^1.96.0" },
      extensionDependencies: ["acme.core"],
    },
    { files: ["package.json", "dist/extension.js"], installed: ["acme.demo"] }
  );
  assert.equal(report.status, "unsupported");
  assert.equal(primaryReason(report)?.code, "missing-dependency");
  assert.match(describeReport(report), /Missing required extension/);
});

check("statusLabel and describeReport cover every status", () => {
  assert.equal(statusLabel("supported"), "Works in CodifyOne");
  assert.equal(statusLabel("limited"), "Limited support");
  assert.equal(statusLabel("unsupported"), "Won't run");

  const supported = classifyExtension(baseManifest, {
    files: ["package.json", "dist/extension.js"],
  });
  assert.equal(describeReport(supported), "Works in CodifyOne");

  const limited = classifyExtension(
    { ...baseManifest, engines: { vscode: "^1.96.0" } },
    { files: ["package.json", "dist/extension.js"] }
  );
  assert.match(describeReport(limited), /^Limited support: Requires VS Code/);
});

console.log(`extensionCompat: ${passed} checks passed`);
