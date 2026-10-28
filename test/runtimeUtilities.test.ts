/**
 * Unit tests for the runtime utility policy.
 *
 * Run with: npm run test:unit
 */
import assert from "node:assert/strict";
import {
  RUNTIMES,
  buildInstallCommand,
  buildInstallPlan,
  canInstallPackages,
  describeRuntime,
  managerForRuntime,
  parseRuntimeVersion,
  validatePackage,
  validatePackageBatch,
} from "../src/runtimeUtilities";

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

// --- runtime summaries -----------------------------------------------------

check("unknown probe is reported as checking, not missing", () => {
  const summary = describeRuntime();
  assert.equal(summary.status, "unknown");
  assert.equal(canInstallPackages(summary), false);
});

check("present runtime with a manager is ready", () => {
  const summary = describeRuntime({
    id: "python",
    present: true,
    version: "3.12.0",
    managers: ["pip"],
  });
  assert.equal(summary.status, "ready");
  assert.equal(summary.version, "3.12.0");
  assert.equal(canInstallPackages(summary), true);
  assert.match(summary.detail, /pure packages/);
});

check("present runtime without a manager is partial", () => {
  const summary = describeRuntime({ id: "node", present: true, managers: [] });
  assert.equal(summary.status, "partial");
  assert.equal(canInstallPackages(summary), false);
});

check("missing runtime names the bundled artifact", () => {
  const summary = describeRuntime({ id: "node", present: false });
  assert.equal(summary.status, "missing");
  assert.match(summary.detail, /node\.wasm/);
  assert.equal(summary.label, RUNTIMES.node.label);
});

check("runtime descriptors match the verified host implementation", () => {
  assert.equal(RUNTIMES.python.artifact, "python.wasm");
  assert.equal(RUNTIMES.node.artifact, "node.wasm");
  assert.equal(RUNTIMES.python.engine, "wasmer");
  assert.equal(RUNTIMES.node.engine, "wasmer");
  // node.wasm is in Copy Bundle Resources + downloadFrameworks.sh; python.wasm
  // is not fetched by any script in CodifyOne.
  assert.equal(RUNTIMES.node.bundledByDefault, true);
  assert.equal(RUNTIMES.python.bundledByDefault, false);
  assert.equal(RUNTIMES.python.managerBinary, "pip");
  assert.equal(RUNTIMES.node.managerBinary, "npm");
  for (const descriptor of Object.values(RUNTIMES)) {
    assert.ok(descriptor.limitations.length >= 3, `${descriptor.id} needs limits`);
  }
});

check("managerForRuntime maps managers to runtimes", () => {
  assert.equal(managerForRuntime("python", "pip"), true);
  assert.equal(managerForRuntime("python", "npm"), false);
  assert.equal(managerForRuntime("node", "npm"), true);
});

// --- validation ------------------------------------------------------------

function ok(manager: "pip" | "npm", name: string, version?: string) {
  const result = validatePackage({ manager, name, version });
  assert.equal(result.ok, true, `expected ${manager}:${name} to be valid`);
  return result.ok ? result.value : undefined;
}

function fails(manager: "pip" | "npm", name: string, version?: string, code?: string) {
  const result = validatePackage({ manager, name, version });
  assert.equal(result.ok, false, `expected ${manager}:${name} to be rejected`);
  if (!result.ok && code) assert.equal(result.error.code, code);
  return result.ok ? undefined : result.error;
}

check("pip accepts normal names, extras and version specifiers", () => {
  ok("pip", "requests");
  ok("pip", "requests", "2.31.0");
  ok("pip", "requests", ">=2,<3");
  ok("pip", "Django");
  ok("pip", "Pillow[extra1,extra2]");
});

check("pip rejects shell syntax, URLs and paths", () => {
  fails("pip", "requests; rm -rf /", undefined, "unsafe-characters");
  fails("pip", "requests && echo owned", undefined, "unsafe-characters");
  fails("pip", "$(whoami)", undefined, "unsafe-characters");
  fails("pip", "https://evil.example/pkg.whl", undefined, "url-not-allowed");
  fails("pip", "./local-package", undefined, "path-not-allowed");
  fails("pip", "../escape", undefined, "path-not-allowed");
  fails("pip", "/tmp/pkg", undefined, "path-not-allowed");
  fails("pip", "requests", "1.0; rm -rf /", "invalid-version");
  fails("pip", "requests", "1.0 --pre", "invalid-version");
  fails("pip", "requests", "1.0\nrm -rf /", "invalid-version");
  fails("pip", "not a name", undefined, "unsafe-characters");
  fails("pip", "requests[", undefined, "invalid-name");
});

check("npm accepts scoped names and ranges", () => {
  ok("npm", "prettier");
  ok("npm", "@types/node");
  ok("npm", "typescript", "^5.5.0");
  ok("npm", "eslint", "8");
});

check("npm rejects uppercase, URLs and injection", () => {
  fails("npm", "React", undefined, "invalid-name");
  fails("npm", "@scope", undefined, "invalid-name");
  fails("npm", "pkg;touch /tmp/x", undefined, "unsafe-characters");
  fails("npm", "git+https://github.com/a/b.git", undefined, "url-not-allowed");
  fails("npm", "pkg", ">=1 <2", "invalid-version");
  fails("npm", "pkg", "1.0&&whoami", "invalid-version");
  fails("npm", "pkg", "1.0;rm", "invalid-version");
});

check("empty and oversized input is rejected", () => {
  fails("pip", "   ", undefined, "empty");
  fails("pip", "a".repeat(300), undefined, "too-long");
});

// --- command building ------------------------------------------------------

check("pip command uses the registered pip entry point", () => {
  assert.equal(
    buildInstallCommand({ manager: "pip", name: "requests", version: "2.31.0" }),
    "pip install --disable-pip-version-check --no-input --no-warn-script-location requests==2.31.0"
  );
  assert.equal(
    buildInstallCommand({ manager: "pip", name: "requests", version: ">=2,<3" }),
    "pip install --disable-pip-version-check --no-input --no-warn-script-location requests>=2,<3"
  );
});

check("npm command disables lifecycle scripts", () => {
  assert.equal(
    buildInstallCommand({ manager: "npm", name: "@types/node", version: "^22" }),
    "npm install --ignore-scripts --no-audit --no-fund @types/node@^22"
  );
});

check("command builder quotes cwd and refuses invalid input", () => {
  assert.equal(
    buildInstallCommand({ manager: "npm", name: "prettier" }, { cwd: "/tmp/my project" }),
    "cd '/tmp/my project' && npm install --ignore-scripts --no-audit --no-fund prettier"
  );
  assert.equal(buildInstallCommand({ manager: "pip", name: "x; y" }), undefined);
});

check("install plan is an argv vector, not a shell string", () => {
  assert.deepEqual(
    buildInstallPlan(
      { manager: "npm", name: "@types/node", version: "^22" },
      { cwd: "/tmp/my project" }
    ),
    {
      file: "npm",
      args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "@types/node@^22"],
      cwd: "/tmp/my project",
    }
  );
  assert.deepEqual(
    buildInstallPlan({ manager: "pip", name: "requests", version: "2.31.0" }),
    {
      file: "pip",
      args: [
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-warn-script-location",
        "requests==2.31.0",
      ],
    }
  );
  const plan = buildInstallPlan({ manager: "npm", name: "prettier" });
  assert.ok(plan);
  // Nothing in argv can be reinterpreted by a shell.
  assert.ok(plan.args.every((arg) => !/[;&|`$\\<>(){}]/.test(arg)));
  assert.equal(buildInstallPlan({ manager: "npm", name: "x; y" }), undefined);
});

check("shell form quotes a cwd containing a single quote", () => {
  assert.equal(
    buildInstallCommand({ manager: "npm", name: "prettier" }, { cwd: "/tmp/it's here" }),
    "cd '/tmp/it'\\''s here' && npm install --ignore-scripts --no-audit --no-fund prettier"
  );
});

check("batch validation dedupes and caps the request size", () => {
  const batch = validatePackageBatch([
    { manager: "pip", name: "requests" },
    { manager: "pip", name: "Requests" },
    { manager: "npm", name: "prettier" },
  ]);
  assert.equal(batch.ok, true);
  if (batch.ok) assert.equal(batch.values.length, 2);

  const tooMany = validatePackageBatch(
    Array.from({ length: 11 }, (_, index) => ({ manager: "pip" as const, name: `pkg${index}` }))
  );
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.error.code, "too-many-packages");

  assert.equal(validatePackageBatch([]).ok, false);
});

check("parseRuntimeVersion handles common output", () => {
  assert.equal(parseRuntimeVersion("Python 3.12.1"), "3.12.1");
  assert.equal(parseRuntimeVersion("v22.3.0"), "22.3.0");
  assert.equal(parseRuntimeVersion("No output"), undefined);
});

console.log(`runtimeUtilities: ${passed} checks passed`);
