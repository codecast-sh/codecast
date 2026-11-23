// The one place the web app constructs a WebSocket. `new WebSocket` throws
// synchronously on a URL the browser rejects ("Failed to construct
// 'WebSocket': the provided URL is invalid", ct-73198), and a throw from a
// connect function escapes every socket's onerror/onclose path straight to the
// global error reporter. This turns that throw into null, so each caller routes
// it to the failure path it already has for a socket that drops.

export function openWebSocket(url: string | null, protocols?: string | string[]): WebSocket | null {
  if (!url) return null;
  try {
    return protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
  } catch {
    return null;
  }
}
