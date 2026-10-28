/**
 * Runtime utility policy for CodifyOne.
 *
 * Verified against the CodifyOne sources (R0GUEEE/CodifyOne) rather than
 * assumed:
 *
 *   - `python`, `python3` and `pip` are `@_cdecl` entry points in
 *     `CodeApp/Utilities/python.swift`. They load `python.wasm` from the app
 *     bundle (or `PYTHON_WASM_PATH`) and run it through `wasmer_execute`.
 *     `CodeApp/CodeApp.swift` maps `python3` onto that command.
 *   - `node`, `npm`, `npx` and `nodeg` are `@_cdecl` entry points in
 *     `CodeApp/Utilities/node.swift`; they load `node.wasm` from the bundle
 *     and also run it through `wasmer_execute`. `npm` is the npm bundle
 *     (`Resources.npm`) executed by `node.wasm`.
 *   - The app *also* embeds native runtimes, but they are not these commands:
 *     `NodeMobile.xcframework` powers the Node app extension (LSP/Java) and
 *     the `python3_ios_*` frameworks under `Resources/cpython` back the native
 *     Python used by the Python LSP. Neither is reachable through the
 *     terminal, so packages installed with pip/npm target the WASM runtimes.
 *
 * Consequences that the UI must not hide:
 *   - no native module support (`pip` packages with C extensions and `npm`
 *     packages with `binding.gyp` / `.node` binaries fail),
 *   - the installer passes `--ignore-scripts` to npm; running `npm install`
 *     by hand in the terminal does not, and lifecycle scripts may then fail,
 *   - the WASM filesystem is the app sandbox exposed by `ios_system`, not a
 *     full Linux userland; Wasmer's host working directory falls back to an
 *     internal runtime directory when the project sits in the app container
 *     (`safeWASMCurrentDirectory` in `CodeApp/Utilities/wasm.swift`), so an
 *     install can land outside the project folder,
 *   - `node.wasm` is copied into the bundle by the Xcode project and fetched
 *     by `downloadFrameworks.sh`, while `python.wasm` is not: the Python
 *     runtime is only usable when a build supplies it, and the probe must be
 *     allowed to report it missing.
 *
 * The installer UI therefore never takes a free-form shell command from the
 * user. It takes a *package name + optional version*, validates it against the
 * rules below and builds a single, fixed-shape command. The native host can
 * mirror `validatePackage` when it needs to agree on what is installable.
 *
 * This module is pure: no DOM, no `vscode`, no network.
 */

export type RuntimeId = "python" | "node";
export type PackageManager = "pip" | "npm";

export interface RuntimeDescriptor {
  id: RuntimeId;
  label: string;
  /** Command users type in the CodifyOne terminal. */
  binary: string;
  /** Package manager command exposed by the same native entry point. */
  managerBinary: PackageManager;
  /** Bundled artifact the native host must find before the runtime is usable. */
  artifact: string;
  /** Execution engine of that artifact. Both runtimes are Wasmer-hosted WASM. */
  engine: "wasmer";
  /**
   * Whether the default build (Xcode Copy Bundle Resources plus
   * `downloadFrameworks.sh`) is known to provide the artifact. `python.wasm`
   * is not downloaded by any script in the CodifyOne repository, so the host
   * may legitimately report it missing.
   */
  bundledByDefault: boolean;
  managers: PackageManager[];
  /** Known, user-visible limitations. Shown verbatim in the UI. */
  limitations: string[];
}

export const RUNTIMES: Record<RuntimeId, RuntimeDescriptor> = {
  python: {
    id: "python",
    label: "Python 3 (WASM, Wasmer)",
    binary: "python3",
    managerBinary: "pip",
    artifact: "python.wasm",
    engine: "wasmer",
    bundledByDefault: false,
    managers: ["pip"],
    limitations: [
      "Runs CPython compiled to WASI/WASIX under Wasmer; it is not the native CPython used by the Python language server.",
      "Only usable when the build ships python.wasm (or PYTHON_WASM_PATH points at one); the current build scripts do not download it.",
      "Pure-Python packages work; packages that compile C extensions do not.",
      "`pip` installs into the WASM-visible sandbox and is removed with the app.",
      "No `venv`, no subprocesses, no arbitrary shell access.",
    ],
  },
  node: {
    id: "node",
    label: "Node.js (WASM, Wasmer)",
    binary: "node",
    managerBinary: "npm",
    artifact: "node.wasm",
    engine: "wasmer",
    bundledByDefault: true,
    managers: ["npm"],
    limitations: [
      "Runs Node.js compiled to WASM under Wasmer; the bundled NodeMobile framework serves the extension host, not the `node` command.",
      "`npm` is the bundled npm CLI executed by node.wasm, so npm's own dependencies must also be WASM-compatible.",
      "Pure-JavaScript packages work; native modules (`binding.gyp`, `.node`) do not.",
      "The installer passes `--ignore-scripts`; a hand-written `npm install` in the terminal does not.",
      "Wasmer may relocate its host working directory, so node_modules can land outside the project folder.",
    ],
  },
};

export interface RuntimeProbe {
  id: RuntimeId;
  /** Whether the bundled artifact was found by the native host. */
  present: boolean;
  /** Version reported by the runtime, when it could be determined. */
  version?: string;
  /** Package managers confirmed to work. */
  managers?: PackageManager[];
}

export type RuntimeStatus = "ready" | "partial" | "missing" | "unknown";

export interface RuntimeSummary {
  id: RuntimeId;
  label: string;
  status: RuntimeStatus;
  version?: string;
  managers: PackageManager[];
  detail: string;
}

/**
 * Turns a probe into a UI-friendly summary. `unknown` is used when the host
 * has not reported anything yet, so the UI can say "checking" instead of
 * claiming a runtime is missing.
 */
export function describeRuntime(probe?: RuntimeProbe): RuntimeSummary {
  if (!probe) {
    return {
      id: "python",
      label: RUNTIMES.python.label,
      status: "unknown",
      managers: [],
      detail: "Runtime status has not been reported by the host yet.",
    };
  }
  const descriptor = RUNTIMES[probe.id];
  const managers = probe.managers ?? (probe.present ? descriptor.managers : []);
  if (!probe.present) {
    return {
      id: probe.id,
      label: descriptor.label,
      status: "missing",
      managers: [],
      detail: descriptor.bundledByDefault
        ? `${descriptor.artifact} is not present in this build of the app.`
        : `${descriptor.artifact} is not present in this build; the default build scripts do not bundle it.`,
    };
  }
  const status: RuntimeStatus = managers.length === 0 ? "partial" : "ready";
  return {
    id: probe.id,
    label: descriptor.label,
    status,
    version: probe.version,
    managers,
    detail:
      status === "ready"
        ? `${descriptor.label} can run and install pure packages.`
        : `${descriptor.label} runs code but no package manager is available.`,
  };
}

/** True when a runtime can install packages without a native toolchain. */
export function canInstallPackages(summary: RuntimeSummary): boolean {
  return summary.status === "ready" && summary.managers.length > 0;
}

// ---------------------------------------------------------------------------
// Package validation
// ---------------------------------------------------------------------------

export type PackageErrorCode =
  | "empty"
  | "too-long"
  | "invalid-name"
  | "invalid-version"
  | "unsafe-characters"
  | "url-not-allowed"
  | "path-not-allowed"
  | "manager-mismatch"
  | "too-many-packages";

export interface PackageError {
  code: PackageErrorCode;
  message: string;
}

export interface PackageRequest {
  manager: PackageManager;
  name: string;
  version?: string;
}

export interface ValidatedPackage {
  manager: PackageManager;
  /** Canonical package name, including extras for pip / scope for npm. */
  name: string;
  version?: string;
}

const MAX_NAME_LENGTH = 214;
const MAX_PACKAGES_PER_REQUEST = 10;

// https://packaging.python.org/en/latest/specifications/name-normalization/
const PIP_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PIP_EXTRA = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// https://docs.npmjs.com/cli/v10/using-npm/package-spec
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// Version specifiers are intentionally narrow: no quotes, spaces, semicolons,
// pipes, backticks, `$`, `&` or path separators, so the result can never be
// interpreted as shell syntax even before quoting.
const PIP_SPECIFIER = /^(?:[A-Za-z0-9.*+!<>=~,-])+$/;
const NPM_SPECIFIER = /^(?:[A-Za-z0-9.^~<>=*+-]){1,64}$/;

function reject(code: PackageErrorCode, message: string): PackageError {
  return { code, message };
}

/** Rejects anything that looks like a URL, a path or shell syntax. */
function unsafeReason(raw: string): PackageError | undefined {
  if (/[\s"'`;|&$\\<>(){}\u0000-\u001f]/.test(raw)) {
    return reject(
      "unsafe-characters",
      "Package specs may not contain spaces, quotes, shell operators or control characters."
    );
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^git\+/i.test(raw)) {
    return reject("url-not-allowed", "Install from URLs or git repositories is not supported.");
  }
  if (raw.startsWith(".") || raw.startsWith("/") || raw.includes("..")) {
    return reject("path-not-allowed", "Install from a local path is not supported.");
  }
  return undefined;
}

/** Validates a package name (and optional version) for one manager. */
export function validatePackage(
  request: PackageRequest
): { ok: true; value: ValidatedPackage } | { ok: false; error: PackageError } {
  const rawName = (request.name ?? "").trim();
  const rawVersion = (request.version ?? "").trim();

  if (!rawName) return { ok: false, error: reject("empty", "Enter a package name.") };
  if (rawName.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      error: reject("too-long", `Package names are limited to ${MAX_NAME_LENGTH} characters.`),
    };
  }

  const unsafe = unsafeReason(rawName);
  if (unsafe) return { ok: false, error: unsafe };
  // Versions are *not* run through `unsafeReason`: pip and npm ranges
  // legitimately contain `<`, `>` and `,`. The per-manager whitelists below
  // exclude spaces, quotes, `;`, `|`, `&`, `$`, backticks, slashes and colons
  // just as strictly, and report `invalid-version` instead.

  if (request.manager === "pip") {
    // `requests[security]` is allowed; the extras are validated separately.
    const extrasMatch = /^([^[\]]+)(?:\[([^\]]*)\])?$/.exec(rawName);
    const base = extrasMatch?.[1] ?? rawName;
    if (!PIP_NAME.test(base)) {
      return {
        ok: false,
        error: reject("invalid-name", `"${base}" is not a valid Python package name.`),
      };
    }
    const extras = extrasMatch?.[2];
    if (extras !== undefined) {
      const parts = extras.split(",").map((part) => part.trim()).filter(Boolean);
      if (parts.length === 0 || !parts.every((part) => PIP_EXTRA.test(part))) {
        return { ok: false, error: reject("invalid-name", "Invalid Python extras list.") };
      }
    }
    if (rawVersion && !PIP_SPECIFIER.test(rawVersion)) {
      return {
        ok: false,
        error: reject("invalid-version", "Use a version specifier such as 1.2.3 or >=1,<2."),
      };
    }
    return {
      ok: true,
      value: { manager: "pip", name: rawName, version: rawVersion || undefined },
    };
  }

  if (!NPM_NAME.test(rawName)) {
    return {
      ok: false,
      error: reject(
        "invalid-name",
        "npm names must be lowercase; scoped names look like @scope/package."
      ),
    };
  }
  if (rawVersion && !NPM_SPECIFIER.test(rawVersion)) {
    return {
      ok: false,
      error: reject("invalid-version", "Use an npm version or range such as 4.17.21 or ^4."),
    };
  }
  return {
    ok: true,
    value: { manager: "npm", name: rawName, version: rawVersion || undefined },
  };
}

/** Checks a whole batch (the UI installs one package at a time, but the API is batched). */
export function validatePackageBatch(
  requests: PackageRequest[]
): { ok: true; values: ValidatedPackage[] } | { ok: false; error: PackageError } {
  if (requests.length === 0) {
    return { ok: false, error: reject("empty", "No packages requested.") };
  }
  if (requests.length > MAX_PACKAGES_PER_REQUEST) {
    return {
      ok: false,
      error: reject(
        "too-many-packages",
        `Install at most ${MAX_PACKAGES_PER_REQUEST} packages at a time.`
      ),
    };
  }
  const values: ValidatedPackage[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const result = validatePackage(request);
    if (!result.ok) return result;
    const key = `${result.value.manager}:${result.value.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(result.value);
  }
  return { ok: true, values };
}

/** True when `manager` belongs to `runtime`. */
export function managerForRuntime(runtime: RuntimeId, manager: PackageManager): boolean {
  return RUNTIMES[runtime].managers.includes(manager);
}

export interface InstallCommandOptions {
  /** Working directory to run the package manager in, when the host knows it. */
  cwd?: string;
}

/**
 * Argument-vector form of an install. This is the shape a native execution
 * bridge should consume: it never needs a shell, so no package name, version
 * or path can turn into a second command.
 */
export interface InstallPlan {
  /** Executable, e.g. `pip` or `npm` (native @_cdecl entry points). */
  file: string;
  args: string[];
  /** Working directory to launch in, when it matters. */
  cwd?: string;
}

/**
 * Builds the validated install plan. Returns `undefined` when validation fails.
 *
 * This is still policy only: nothing in this repository executes the plan.
 */
export function buildInstallPlan(
  request: PackageRequest,
  options: InstallCommandOptions = {}
): InstallPlan | undefined {
  const validated = validatePackage(request);
  if (!validated.ok) return undefined;
  const { manager, name, version } = validated.value;

  if (manager === "pip") {
    const spec = !version
      ? name
      : /^[<>=~!]/.test(version)
        ? `${name}${version}`
        : `${name}==${version}`;
    // `pip` is the native entry point registered in CodeApp.swift; it forwards
    // to `python -m pip` inside python.wasm, which is the same path a user
    // takes in the terminal. It installs into the WASM site-packages, so the
    // working directory is irrelevant.
    return {
      file: RUNTIMES.python.managerBinary,
      args: [
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-warn-script-location",
        spec,
      ],
    };
  }

  const spec = version ? `${name}@${version}` : name;
  return {
    file: "npm",
    args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", spec],
    cwd: options.cwd,
  };
}

/**
 * Shell-string form, for display in the installer UI and for the terminal.
 *
 * The shape is fixed per manager so no user-controlled text can introduce a
 * second command. Returns `undefined` when validation fails.
 */
export function buildInstallCommand(
  request: PackageRequest,
  options: InstallCommandOptions = {}
): string | undefined {
  const plan = buildInstallPlan(request, options);
  if (!plan) return undefined;
  // `cwd` is the only interpolated path and is single-quoted by shellQuote.
  const prefix = plan.cwd ? `cd ${shellQuote(plan.cwd)} && ` : "";
  return `${prefix}${plan.file} ${plan.args.join(" ")}`;
}

/** Minimal single-quote escaping for the one path we interpolate (`cwd`). */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Parses `python3 --version` / `node --version` style output. */
export function parseRuntimeVersion(output: string): string | undefined {
  const match = /v?(\d+\.\d+(?:\.\d+)?)/.exec(output ?? "");
  return match?.[1];
}
