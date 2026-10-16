// A Convex client that never touches the network, for tests that only need a
// provider (or stub its query and mutation methods). A real client opens its
// WebSocket on construction: on CI it reached the real cloud, which answered
// "Couldn't parse deployment name" with a fatal error thrown later, into
// whatever test happened to be running in that process.
import { ConvexReactClient } from "convex/react";

class NoSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  onerror = null;
  send() {}
  close() {}
}

export function offlineConvexClient(url = "https://example.convex.cloud"): ConvexReactClient {
  return new ConvexReactClient(url, { webSocketConstructor: NoSocket as any, unsavedChangesWarning: false, skipConvexDeploymentUrlCheck: true } as any);
}
