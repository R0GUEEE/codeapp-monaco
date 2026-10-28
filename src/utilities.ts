import type { WorkerConfig } from "@codingame/monaco-vscode-extensions-service-override";
// `?worker&url` makes Vite emit the extension host worker and hand back its
// final asset URL. The previous `new URL("vscode/workers/...", import.meta.url)`
// resolved to `src/vscode/...`, so the extension host never started.
import extensionHostWorkerUrl from "vscode/workers/extensionHost.worker?worker&url";

export function decodeBase64(base64: string): string {
  return decodeURIComponent(escape(atob(base64)));
}

export const workerConfig: WorkerConfig = {
  url: extensionHostWorkerUrl,
  options: { type: "module" },
};
