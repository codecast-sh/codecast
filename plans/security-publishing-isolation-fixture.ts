// Does a trusted document survive being nested inside a sandboxed one?
//
// The proposed remedy for PARENT-03 puts publisher content in one document
// and the codecast controls in another. Which one has to be the ancestor
// depends on whether the CSP sandbox is inherited downward. If a child frame
// on its own origin can still reach that origin's storage, the controls can
// stay in a small frame inside the page (no layout change at all). If the
// sandbox is inherited, the controls must be the OUTER document and publisher
// content must move into a frame — a much larger user-visible change.
//
// Two ports so the frames are cross-origin, exactly as they would be in
// production (a.codecast.sh vs codecast.sh). No real capability anywhere:
// the "secret" is a synthetic marker string.
const OUTER = 43191;
const INNER = 43192;
const SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock";

// The "trusted controls" document: it wants its own origin's storage, which is
// where a real capability would live instead of in a URL fragment.
const controls = `<!doctype html><title>controls</title><body><script>
  var out = { origin: location.origin, storage: null, error: null };
  try { localStorage.setItem("cc_synthetic_marker", "present"); out.storage = localStorage.getItem("cc_synthetic_marker"); }
  catch (e) { out.error = String(e && e.name); }
  document.title = JSON.stringify(out);
  parent.postMessage(out, "*");
</script></body>`;

// A published page as it is served today, with the controls nested inside it.
const page = (label) => `<!doctype html><title>${label}</title><body>
  <h1 id="h">${label}</h1>
  <iframe id="f" src="http://127.0.0.1:${INNER}/controls" style="width:300px;height:80px"></iframe>
  <pre id="out">pending</pre>
  <script>
    var seen = { self: null, child: null };
    try { localStorage.setItem("x","1"); seen.self = "reachable"; } catch (e) { seen.self = String(e && e.name); }
    addEventListener("message", function (ev) { seen.child = ev.data; document.getElementById("out").textContent = JSON.stringify(seen); });
    document.getElementById("out").textContent = JSON.stringify(seen);
  </script></body>`;

Bun.serve({ hostname: "127.0.0.1", port: INNER, fetch: () =>
  new Response(controls, { headers: { "Content-Type": "text/html" } }) });

Bun.serve({ hostname: "127.0.0.1", port: OUTER, fetch(request) {
  // /sandboxed = today's published page. /plain = the same page with no CSP,
  // as a control, so a null result can be told apart from a broken fixture.
  const sandboxed = new URL(request.url).pathname !== "/plain";
  return new Response(page(sandboxed ? "sandboxed page" : "plain page"), {
    headers: { "Content-Type": "text/html", ...(sandboxed ? { "Content-Security-Policy": SANDBOX } : {}) },
  });
} });
console.log(`outer http://127.0.0.1:${OUTER}/  (and /plain)   inner http://127.0.0.1:${INNER}/controls`);
