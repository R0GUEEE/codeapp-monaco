/**
 * Thin wrapper around the WKWebView message bridge.
 *
 * The editor runs inside a WKWebView whose host (CodifyOne.app) installs a
 * script message handler named `toggleMessageHandler`. When the same bundle is
 * loaded in a plain browser (dev / CI smoke test) that handler does not exist,
 * so every post must be defensive.
 */

export type NativeEvent = Record<string, unknown> & { Event: string };

export function hasNativeBridge(): boolean {
  return !!(
    (window as any).webkit &&
    (window as any).webkit.messageHandlers &&
    (window as any).webkit.messageHandlers.toggleMessageHandler
  );
}

export function postToNative(event: NativeEvent): void {
  if (!hasNativeBridge()) return;
  try {
    (window as any).webkit.messageHandlers.toggleMessageHandler.postMessage(
      event
    );
  } catch (e) {
    // Never let a bridge failure break the editor.
    console.error("postToNative failed", e);
  }
}
