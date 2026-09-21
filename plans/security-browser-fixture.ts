import { brandArtifactHtml } from "../packages/convex/convex/artifactPages";

const base = "http://127.0.0.1:43187";
const content = `<html><head><title>Local artifact isolation check</title></head><body><h1>Local artifact isolation check</h1><p id="result">Pending</p><script>const params = new URLSearchParams(location.hash.slice(1)); document.getElementById('result').textContent = JSON.stringify({ownerFixtureVisible: params.get('o') === 'synthetic-owner-marker', identityFixtureVisible: params.get('i') === 'synthetic-identity-marker'});</script></body></html>`;
const html = brandArtifactHtml(content, {
  title: "Local artifact isolation check", author: "Synthetic fixture", updatedAt: Date.now(),
  shareUrl: base, version: 1, currentVersion: 1, metaUrl: `${base}/meta`, apiBase: base,
  slug: "fixture123", kind: "html", sessionShortId: null, sessionTitle: null, views: 0,
  commentCount: 0, commentsEnabled: false, gated: { password: false, email: false },
  editMode: "owner", live: false, hasThumb: false,
});

Bun.serve({
  hostname: "127.0.0.1", port: 43187,
  fetch(request) {
    if (new URL(request.url).pathname !== "/") return Response.json({}, { headers: { "Access-Control-Allow-Origin": "*" } });
    return new Response(html, { headers: {
      "Content-Type": "text/html",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    } });
  },
});
