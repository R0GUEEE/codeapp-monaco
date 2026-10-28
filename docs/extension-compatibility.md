# Extension compatibility and runtime utility policy

This branch adds a pre-flight compatibility layer for the VS Code web extension
host and a pure policy module for the WASM package managers. It is deliberately
**policy and classification only**: there is no installer UI and no native
execution bridge in this repository, and nothing here claims VS Code parity.

## What ships

### `src/extensionCompat.ts` — pure classifier

No `vscode`, DOM or network imports, so it is unit-testable and can be mirrored
by the native host.

- `classifyExtension(manifest, { files, installed, entrySource })` returns
  `supported | limited | unsupported` plus machine-readable reasons
  (`node-entry-only`, `missing-browser-entry`, `missing-dependency`,
  `engine-newer`, `node-api-usage`, `native-module`, `extension-pack`,
  `dependency-cycle`, …).
- Engine checks compare against `SUPPORTED_VSCODE_ENGINE = "1.90.2"`, verified
  from `node_modules/vscode/api.js` for `@codingame/monaco-vscode-api` 6.0.3.
  A newer requirement is a *warning* (contributions still load), not a hard
  block.
- `orderByDependencies` sorts activation order and reports cycles instead of
  silently dropping members.
- `fetchEntrySource` reads the `browser` bundle over the native file server for
  static Node-builtin / native-module detection. It aborts after 5 s so a
  stalled server cannot hang `loadExtensions`.

### `src/extensions.ts` — registration integration

`loadExtensions()` classifies each enabled package before registering it:

- `unsupported` packages are not registered; the native host receives an
  `Extension Error` event with `code` and a `compat` summary.
- `limited` packages still register; the status and reasons travel on the
  `Extension Ready` payload and through `window.codeExtensions.list()`.
- New read-only facade methods: `window.codeExtensions.compat(id)` and
  `window.codeExtensions.reports()`.

The index contract is the existing one produced by
`CodeApp/Services/ExtensionRuntime.swift`: `{ id, path, baseUrl, files,
manifest, enabled, source }`. No Swift change is required for classification.

### `src/runtimeUtilities.ts` — package manager policy

Documents the two Wasmer-hosted runtimes that the CodifyOne terminal exposes
(`python3`/`pip` and `node`/`npm`, both via `wasmer_execute`), validates package
names and version ranges, and produces either:

- `buildInstallPlan()` → `{ file, args, cwd? }`, an argv vector that needs no
  shell (the preferred shape for a future native bridge), or
- `buildInstallCommand()` → the same command as a display string.

Rejected before any command is built: whitespace, quotes, semicolons, pipes,
ampersands, `$`, backticks, angle brackets, parentheses, control characters,
URLs, `git+`, local paths, and shell-shaped versions.

### Build fixes required for the extension host

- `src/utilities.ts`: `import ... from "vscode/workers/extensionHost.worker?worker&url"`
  replaces `new URL("vscode/workers/...", import.meta.url)`, which resolved to
  `src/vscode/...` and left the extension host dead.
- `src/client.ts`: `monaco-editor/esm/vs/editor/editor.worker?worker` replaces
  the same broken `new URL(...)` pattern for the editor worker.

Both specifiers were verified locally with Vite 5.3.5: the build emits
`assets/editor.worker-*.js` and `assets/extensionHost.worker-*.js`.

### CI

`.github/workflows/bundle.yml` now runs, before the bundle build:

- `npm run test:unit` (compatibility + runtime policy tests),
- `npm run typecheck` (`tsconfig.json` and `tsconfig.test.json`),
- then `npm run build`, the bundle-output assertions, and the Playwright
  extension smoke test. The previous `tsc ... || true` is gone, so a type error
  fails the workflow.

## Known limitations (do not overstate)

- **No installer UI or execution bridge.** `buildInstallPlan()` is not called by
  any shipping code path; installing packages from the editor is not wired.
- **`python.wasm` is not bundled by default.** No script in CodifyOne downloads
  it; the Python runtime only works when a build supplies it (`PYTHON_WASM_PATH`).
  Node/npm ship `node.wasm`, but native modules still cannot load.
- **No native module support** in either runtime: `pip` packages with C
  extensions and npm packages with `.node` binaries fail. The policy passes
  `--ignore-scripts`; a manual `npm install` in the terminal does not.
- **Wasmer may relocate its working directory**, so `node_modules` can land
  outside the project folder.
- **Static analysis is heuristic.** It sees literal `require`/`import` of Node
  built-ins and `.node` references; dynamic or bundled-together usage is
  invisible. `limited` means "may work", not "tested".
- **Engine parity:** the host implements VS Code 1.90.2 APIs. Extensions
  requiring newer APIs are reported as `limited`; no attempt is made to polyfill.
- **Extension packs are not expanded**; members must be installed individually.
- **Native UI is not wired.** The Swift host handles `Extension Ready`,
  `Extension Error` and `Extension Unloaded` only. Compatibility text in the
  Extensions sidebar requires consuming `window.codeExtensions.list()` — a
  separate CodifyOne change.
- Vite production builds were **not** run on-device (the iSH process is killed
  during the large transform); GitHub Actions is the authoritative build/smoke
  proof.

## Next steps

1. CodifyOne: call `window.codeExtensions.load()` / `list()` after install and
   render `compat` in the Extensions sidebar; add a diagnostics sheet backed by
   `reports()`.
2. Add a native runtime probe (`python3 --version`, `node --version`, artifact
   existence) and feed it to `describeRuntime`.
3. If an installer is wanted, execute `buildInstallPlan()` argv through the
   existing `ios_system` command entry points — never a shell string — and show
   `RUNTIMES[id].limitations` verbatim.
4. Extend the classifier with per-API checks once the host's missing-API list is
   available, and expand extension packs in the native index.
