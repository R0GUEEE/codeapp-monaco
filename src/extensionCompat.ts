/**
 * Extension compatibility analysis for CodifyOne.
 *
 * The editor runs the real VS Code web extension host, so a package only runs
 * if it ships a `browser` entry point. Everything else (Node entry points,
 * native modules, missing files, unsatisfied extension dependencies) has to be
 * reported *before* the extension host activates it, otherwise the failure is
 * buried in the extension host log and the UI just shows a dead extension.
 *
 * This module is deliberately pure: no `vscode` import, no DOM, no network.
 * That keeps it unit-testable (`npm run test:unit`) and lets the native side
 * mirror the same rules when it builds `index.json`.
 */

export type CompatStatus = "supported" | "limited" | "unsupported";

export type CompatReasonCode =
  | "declarative-only"
  | "no-entry-point"
  | "node-entry-only"
  | "missing-browser-entry"
  | "missing-main-entry"
  | "engine-newer"
  | "engine-unparseable"
  | "node-api-usage"
  | "native-module"
  | "extension-pack"
  | "missing-dependency"
  | "dependency-cycle";

export interface CompatReason {
  code: CompatReasonCode;
  message: string;
  /** Affected module / dependency / engine range, when relevant. */
  detail?: string;
}

export interface CompatReport {
  id: string;
  status: CompatStatus;
  /** Entry point the web host would use (`browser`, or `main` for reports). */
  entryPoint?: string;
  /** `web`, `node` or `declarative`. */
  kind: "web" | "node" | "declarative";
  reasons: CompatReason[];
  /** Node built-ins referenced by the entry point, sorted. */
  nodeModules: string[];
  /** Dependency ids that are declared but not installed. */
  missingDependencies: string[];
}

export interface ManifestLike {
  name?: string;
  publisher?: string;
  version?: string;
  main?: string;
  browser?: string;
  engines?: { vscode?: string } | string;
  extensionDependencies?: string[];
  extensionPack?: string[];
  extensionKind?: string[];
  activationEvents?: string[];
  contributes?: Record<string, unknown>;
}

/**
 * VS Code API level that `@codingame/monaco-vscode-api` ~6.0.3 implements.
 *
 * Verified from the installed package: `node_modules/vscode/api.js` is
 * generated from VS Code 1.90.2. Keep this in sync when bumping the
 * `vscode`/`monaco-vscode-api` aliases in package.json.
 */
export const SUPPORTED_VSCODE_ENGINE = "1.90.2";

const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/**
 * Built-ins that the web extension host cannot provide at all (no filesystem,
 * no processes, no sockets). Their presence in a `browser` bundle means the
 * extension will probably throw during activation.
 */
const BLOCKING_NODE_MODULES = new Set([
  "child_process",
  "cluster",
  "dgram",
  "fs",
  "fs/promises",
  "module",
  "net",
  "tls",
  "v8",
  "vm",
  "worker_threads",
]);

/** Modules that exist but behave differently in the web host. */
const DEGRADED_NODE_MODULES = new Set([
  "crypto",
  "http",
  "http2",
  "https",
  "perf_hooks",
  "process",
  "timers",
  "zlib",
]);

const ENTRY_SOURCE_LIMIT = 512 * 1024;

// ---------------------------------------------------------------------------
// Version handling (minimal semver subset: enough for `engines.vscode`)
// ---------------------------------------------------------------------------

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(value: string): Version | undefined {
  const match = /^\s*[\^~>=<]*\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function bump(range: string, base: Version): Version {
  // ^ and ~ expansion, following npm semantics closely enough for engines.
  if (range === "^") {
    if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
    if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
    return { major: 0, minor: 0, patch: base.patch + 1 };
  }
  // ~
  return { major: base.major, minor: base.minor + 1, patch: 0 };
}

function matchesComparator(comparator: string, version: Version): boolean {
  const opMatch = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator.trim());
  if (!opMatch) return false;
  const op = opMatch[1] ?? "=";
  const raw = opMatch[2];
  if (raw === "*" || raw === "x" || raw === "X") return true;

  const base = parseVersion(raw);
  if (!base) return false;

  // Partial versions (`1.83`) behave like ranges, not exact pins.
  const parts = raw.replace(/^v/, "").split(".");
  const isPartial = parts.length < 3 && !/x|X|\*/.test(raw);

  switch (op) {
    case ">=":
      return compareVersions(version, base) >= 0;
    case ">":
      return compareVersions(version, base) > 0;
    case "<=":
      return compareVersions(version, base) <= 0;
    case "<":
      return compareVersions(version, base) < 0;
    case "^":
      return (
        compareVersions(version, base) >= 0 &&
        compareVersions(version, bump("^", base)) < 0
      );
    case "~":
      return (
        compareVersions(version, base) >= 0 &&
        compareVersions(version, bump("~", base)) < 0
      );
    default:
      if (isPartial) {
        const upper: Version = {
          major: base.major,
          minor: base.minor + 1,
          patch: 0,
        };
        if (parts.length === 1) {
          upper.major = base.major + 1;
          upper.minor = 0;
        }
        return (
          compareVersions(version, base) >= 0 &&
          compareVersions(version, upper) < 0
        );
      }
      return compareVersions(version, base) === 0;
  }
}

/** Does `version` satisfy the npm-style range `range`? */
export function satisfies(range: string, version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const trimmed = range.trim();
  if (!trimmed || trimmed === "*") return true;

  return trimmed.split("||").some((alternative) => {
    const text = alternative.trim();
    if (!text) return true;
    // Hyphen ranges: "1.70 - 1.85"
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const low = parseVersion(hyphen[1]);
      const high = parseVersion(hyphen[2]);
      if (!low || !high) return false;
      return (
        compareVersions(parsed, low) >= 0 && compareVersions(parsed, high) <= 0
      );
    }
    // Space separated comparators are ANDed; `^1.2.3` has no space, so a
    // simple split is correct for the ranges extensions actually use.
    const comparators = text.split(/\s+/).filter(Boolean);
    return comparators.every((comparator) =>
      matchesComparator(comparator, parsed)
    );
  });
}

// ---------------------------------------------------------------------------
// Static inspection
// ---------------------------------------------------------------------------

function stripNodePrefix(id: string): string {
  return id.startsWith("node:") ? id.slice(5) : id;
}

/**
 * Finds Node built-ins referenced by a bundle. Matches `require("fs")`,
 * `import ... from "node:fs"` and dynamic `import("fs")`.
 */
export function collectNodeApiUsage(source: string): string[] {
  const found = new Set<string>();
  const pattern =
    /(?:\brequire\s*\(\s*|\bfrom\s*|\bimport\s*\(\s*)["']((?:node:)?[a-z_][a-z0-9_/.-]*)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const id = stripNodePrefix(match[1]);
    if (NODE_BUILTINS.has(id)) found.add(id);
  }
  return [...found].sort();
}

export function detectNativeModules(source: string): boolean {
  return (
    /\.node["']/.test(source) ||
    /\bprocess\s*\.\s*dlopen\s*\(/.test(source) ||
    /\brequire\s*\(\s*["'][^"']+\.node["']\s*\)/.test(source)
  );
}

function normalizeRelative(file: string): string {
  return file.replace(/^\.\//, "").replace(/^\/+/, "");
}

function hasEntryFile(files: string[] | undefined, entry: string): boolean {
  if (!files || files.length === 0) return true; // cannot verify
  const wanted = normalizeRelative(entry);
  return files.some((file) => normalizeRelative(file) === wanted);
}

function contributionKinds(manifest: ManifestLike): string[] {
  const contributes = (manifest.contributes ?? {}) as Record<string, unknown>;
  return Object.keys(contributes).filter((key) => {
    const value = contributes[key];
    return Array.isArray(value) ? value.length > 0 : !!value;
  });
}

function engineRange(manifest: ManifestLike): string | undefined {
  const engines = manifest.engines;
  if (!engines) return undefined;
  if (typeof engines === "string") return engines;
  return engines.vscode;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  /** Installed extension ids, for `extensionDependencies` checks. */
  installed?: Iterable<string>;
  /** Source text of the `browser` entry point, when available. */
  entrySource?: string;
  /** Package-relative file list from the native index. */
  files?: string[];
}

export function classifyExtension(
  manifest: ManifestLike,
  options: ClassifyOptions = {}
): CompatReport {
  const id =
    manifest.publisher && manifest.name
      ? `${manifest.publisher}.${manifest.name}`
      : manifest.name ?? "unknown.extension";

  const browser = manifest.browser ? normalizeRelative(manifest.browser) : undefined;
  const main = manifest.main ? normalizeRelative(manifest.main) : undefined;
  const contributes = contributionKinds(manifest);
  const reasons: CompatReason[] = [];

  let status: CompatStatus = "supported";
  let kind: CompatReport["kind"] = "web";
  let entryPoint = browser;

  if (!browser) {
    if (main) {
      kind = "node";
      status = "unsupported";
      reasons.push({
        code: "node-entry-only",
        detail: main,
        message:
          "This extension only has a Node entry point (\"main\") and no \"browser\" entry, so it cannot run in the web extension host.",
      });
      entryPoint = main;
    } else if (contributes.length > 0) {
      kind = "declarative";
      reasons.push({
        code: "declarative-only",
        message: `Declarative extension (${contributes.join(", ")}); no code is activated, contributions work as-is.`,
      });
    } else {
      kind = "node";
      status = "unsupported";
      reasons.push({
        code: "no-entry-point",
        message:
          "The manifest declares neither \"main\" nor \"browser\" and contributes nothing, so there is nothing to run.",
      });
    }
  } else if (!hasEntryFile(options.files, browser)) {
    status = "unsupported";
    reasons.push({
      code: "missing-browser-entry",
      detail: browser,
      message: `The declared browser entry point "${browser}" is not present in the package.`,
    });
  }

  // Engine compatibility: a newer required API is a warning, not a hard block.
  const range = engineRange(manifest);
  if (range && !satisfies(range, SUPPORTED_VSCODE_ENGINE)) {
    if (!parseVersion(range.replace(/^[\^~><=\s]+/, ""))) {
      reasons.push({
        code: "engine-unparseable",
        detail: range,
        message: `Could not parse the required VS Code engine range "${range}".`,
      });
    } else {
      reasons.push({
        code: "engine-newer",
        detail: range,
        message: `Requires VS Code ${range}; this host implements ${SUPPORTED_VSCODE_ENGINE}. Contributions load, but newer APIs may be missing.`,
      });
    }
    if (status === "supported") status = "limited";
  }

  // Extension packs are metadata-only; the referenced extensions must be
  // installed individually until the installer resolves packs.
  if ((manifest.extensionPack ?? []).length > 0) {
    reasons.push({
      code: "extension-pack",
      detail: (manifest.extensionPack ?? []).join(", "),
      message:
        "Extension pack: member extensions are not installed automatically yet; install them individually.",
    });
    if (status === "supported") status = "limited";
  }

  // Dependencies: the host refuses to activate an extension whose dependency
  // is missing, so report it as unsupported instead of failing at activation.
  const missingDependencies: string[] = [];
  if (options.installed) {
    const installed = new Set(options.installed);
    for (const dependency of manifest.extensionDependencies ?? []) {
      // Extension ids are case-insensitive in VS Code.
      const found = [...installed].some(
        (candidate) => candidate.toLowerCase() === dependency.toLowerCase()
      );
      if (!found) missingDependencies.push(dependency);
    }
    if (missingDependencies.length > 0) {
      reasons.push({
        code: "missing-dependency",
        detail: missingDependencies.join(", "),
        message: `Missing required extension${missingDependencies.length > 1 ? "s" : ""}: ${missingDependencies.join(", ")}.`,
      });
      status = "unsupported";
    }
  }

  // Static Node API usage in the browser bundle.
  const nodeModules = options.entrySource
    ? collectNodeApiUsage(options.entrySource)
    : [];
  if (options.entrySource && detectNativeModules(options.entrySource)) {
    reasons.push({
      code: "native-module",
      message:
        "The bundle references a native (.node) module; native modules cannot be loaded by the web extension host.",
    });
    if (status === "supported") status = "limited";
  }
  if (nodeModules.length > 0) {
    const blocking = nodeModules.filter((id) => BLOCKING_NODE_MODULES.has(id));
    const degraded = nodeModules.filter((id) => DEGRADED_NODE_MODULES.has(id));
    reasons.push({
      code: "node-api-usage",
      detail: nodeModules.join(", "),
      message:
        blocking.length > 0
          ? `Uses Node built-ins that the web host cannot provide (${blocking.join(", ")}); activation may fail.`
          : degraded.length > 0
            ? `Uses Node built-ins with limited web support (${degraded.join(", ")}).`
            : `Uses Node built-ins that are polyfilled in the web host (${nodeModules.join(", ")}).`,
    });
    if (status === "supported") status = "limited";
  }

  return {
    id,
    status,
    kind,
    entryPoint,
    reasons,
    nodeModules,
    missingDependencies,
  };
}

/**
 * Sorts extensions so dependencies activate first. Cycles are reported instead
 * of being silently dropped; the affected packages stay in the order they were
 * encountered and are annotated with a `dependency-cycle` reason.
 */
export function orderByDependencies<
  T extends { id: string; manifest: ManifestLike }
>(entries: T[]): { order: T[]; cycles: string[][]; reports: CompatReport[] } {
  const byId = new Map<string, T>();
  for (const entry of entries) byId.set(entry.id.toLowerCase(), entry);

  const order: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  const cycleMembers = new Set<string>();

  const visit = (entry: T, stack: string[]) => {
    const key = entry.id.toLowerCase();
    const current = state.get(key);
    if (current === "done") return;
    if (current === "visiting") {
      const start = stack.findIndex((id) => id === key);
      const cycle = stack.slice(start >= 0 ? start : 0).concat(key);
      cycles.push(cycle);
      cycle.forEach((id) => cycleMembers.add(id));
      return;
    }
    state.set(key, "visiting");
    for (const dependency of entry.manifest.extensionDependencies ?? []) {
      const target = byId.get(dependency.toLowerCase());
      if (target) visit(target, stack.concat(key));
    }
    state.set(key, "done");
    order.push(entry);
  };

  for (const entry of entries) visit(entry, []);

  const installed = entries.map((entry) => entry.id);
  const reports = entries.map((entry) => {
    const report = classifyExtension(entry.manifest, { installed });
    if (cycleMembers.has(entry.id.toLowerCase())) {
      report.reasons.push({
        code: "dependency-cycle",
        message:
          "Circular extension dependency detected; activation order may be unstable.",
      });
      if (report.status === "supported") report.status = "limited";
    }
    return report;
  });

  return { order, cycles, reports };
}

/** Default ceiling for reading an entry point over the native file server. */
const ENTRY_SOURCE_TIMEOUT_MS = 5000;

/**
 * Reads the entry source for static analysis, tolerating any failure.
 *
 * The file server is local (`WKURLSchemeHandler` / the CI fixture server), but
 * a stalled response would otherwise block `loadExtensions` forever, so the
 * request is aborted after `timeoutMs` and the extension is classified from
 * its manifest alone.
 */
export async function fetchEntrySource(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = ENTRY_SOURCE_TIMEOUT_MS
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    return text.length > ENTRY_SOURCE_LIMIT
      ? text.slice(0, ENTRY_SOURCE_LIMIT)
      : text;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Reasons ordered by how much they explain the current status: a package that
 * is unsupported because a dependency is missing should show that instead of
 * the (also true but secondary) "engine is newer" note.
 */
const REASON_PRIORITY: CompatReasonCode[] = [
  "missing-dependency",
  "missing-browser-entry",
  "node-entry-only",
  "no-entry-point",
  "native-module",
  "node-api-usage",
  "extension-pack",
  "engine-newer",
  "engine-unparseable",
  "dependency-cycle",
  "declarative-only",
];

/** The most relevant reason for a report, used for one-line UI copy. */
export function primaryReason(report: CompatReport): CompatReason | undefined {
  for (const code of REASON_PRIORITY) {
    const reason = report.reasons.find((candidate) => candidate.code === code);
    if (reason) return reason;
  }
  return report.reasons[0];
}

/** Short label for badges in the native Extensions sidebar. */
export function statusLabel(status: CompatStatus): string {
  switch (status) {
    case "supported":
      return "Works in CodifyOne";
    case "limited":
      return "Limited support";
    default:
      return "Won't run";
  }
}

/** Human readable one-liner: label plus the most relevant reason. */
export function describeReport(report: CompatReport): string {
  const label = statusLabel(report.status);
  const reason = primaryReason(report);
  if (!reason || reason.code === "declarative-only") return label;
  return `${label}: ${reason.message}`;
}
