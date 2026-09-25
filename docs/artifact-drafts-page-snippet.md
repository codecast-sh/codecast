# Keeping a viewer's draft on a published page

A published artifact is served with

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock
```

and deliberately **without** `allow-same-origin`. That is the boundary that
stops published HTML from ever acting with real `convex.codecast.sh`
privileges, and it is not moving. Its cost is that the document has an *opaque
origin*, so `localStorage`, `sessionStorage`, IndexedDB and OPFS all throw
`SecurityError`. A page that contains an editor therefore cannot keep the
viewer's unsent text across a reload, a navigation, or a browser crash.

Two routes fix that server-side. They are open to the page (`Access-Control-
Allow-Origin: *`, same as the comment route) and gated the same way commenting
is — the slug must exist and comments must be on.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /cli/artifacts/draft` | `{slug, key, author, text}` | `{ok:true, updated_at}` — empty `text` deletes the draft (`{ok:true, cleared:true}`) |
| `POST /cli/artifacts/drafts` | `{slug, author}` | `{drafts:[{key, text, updated_at}]}` |

`key` is whatever the page calls the field it is saving; the server never
interprets it. One row per `(artifact, key, author)`, text capped at 64k, 500
draft rows per page (the oldest is evicted past that).

**A draft is not a comment.** It never enters the discussion, never appears in
`cast publish comments`, and never notifies or reaches the owner's session.

**`author` is an unverified viewer-typed name**, the same string the comment box
uses. Anyone who can guess the name can read that name's drafts on that page —
the same footing as posting a comment under any name. Use this for convenience,
not for anything that needs to stay private.

## Drop-in patch for the "Suggest your changes" editor

Written in the page's existing plain-ES5 style; no build step. It keeps the
300 ms in-memory save exactly as-is and layers the server save on top, so the
page degrades to today's behaviour if the network is gone.

### 1. Paste this block next to the existing `sGet` / `sSet` / `sDel` helpers

```js
/* --- server-side drafts ---------------------------------------------------
   The sandbox CSP gives this page an opaque origin, so localStorage throws and
   sGet/sSet fall back to page-lifetime memory — a reload or a crash loses the
   draft. These helpers mirror every draft to codecast instead. */
var SG_API   = "https://convex.codecast.sh";
var SG_SLUG  = (location.pathname.match(/\/a\/([A-Za-z0-9]{6,32})/) || [])[1] || "";
var sgRemote = {};            /* key -> {text, updated_at} loaded from the server */
var sgTimer  = null;

function sgWho() {
  var el = document.querySelector(".sg-who");
  return ((el && el.value) || "").trim() || "anonymous";
}

function sgPost(path, body) {
  return fetch(SG_API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); });
}

function sgWhen(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (e) { return "just now"; }
}

/* Every draft this name has on this page. Call on load, and again whenever the
   name field changes — drafts are per-author. */
function sgLoadDrafts() {
  if (!SG_SLUG) return Promise.resolve();
  return sgPost("/cli/artifacts/drafts", { slug: SG_SLUG, author: sgWho() })
    .then(function (r) {
      sgRemote = {};
      var list = (r && r.drafts) || [];
      for (var i = 0; i < list.length; i++) sgRemote[list[i].key] = list[i];
    })
    .catch(function () { /* offline: the in-memory draft still works */ });
}

/* Debounced mirror. Slower than the 300 ms local save on purpose — this is a
   network write, and losing at most the last 1.5 s of typing to a crash is the
   trade. */
function sgSaveRemote(key, text) {
  if (!SG_SLUG) return;
  clearTimeout(sgTimer);
  sgTimer = setTimeout(function () {
    sgPost("/cli/artifacts/draft", { slug: SG_SLUG, key: key, author: sgWho(), text: text })
      .then(function (r) {
        if (r && r.ok) {
          sgRemote[key] = { key: key, text: text, updated_at: r.updated_at };
          sgFoot("Saved to codecast at " + sgWhen(r.updated_at) + ".");
        } else {
          sgFoot("Could not save to codecast — keep this tab open.");
        }
      })
      .catch(function () { sgFoot("Could not save to codecast — keep this tab open."); });
  }, 1500);
}

function sgClearRemote(key) {
  if (!SG_SLUG) return;
  clearTimeout(sgTimer);
  delete sgRemote[key];
  sgPost("/cli/artifacts/draft", { slug: SG_SLUG, key: key, author: sgWho(), text: "" })
    .catch(function () {});
}

/* Last-moment flush when the tab closes or is hidden. sendBeacon survives the
   unload that a pending fetch would not; text/plain keeps it a CORS-simple
   request (the server parses the body as JSON regardless of the type). */
function sgFlush(key, text) {
  if (!SG_SLUG || !navigator.sendBeacon) return;
  var payload = JSON.stringify({ slug: SG_SLUG, key: key, author: sgWho(), text: text });
  try {
    navigator.sendBeacon(SG_API + "/cli/artifacts/draft",
      new Blob([payload], { type: "text/plain;charset=UTF-8" }));
  } catch (e) {}
}

sgLoadDrafts();
```

`sgFoot(msg)` is the page's existing footer setter — use whatever it is
actually called there. The footer line

> This browser cannot keep drafts; send before you leave.

is no longer true and should go; leave it as the fallback the page shows only
when `SG_SLUG` is empty or the first `sgLoadDrafts()` rejects.

### 2. In `open(key)` — prefer whichever draft is newer

Replace the `sGet("sg:" + key)` restore with:

```js
var local  = sGet("sg:" + key);              /* {text, at} or null */
var remote = sgRemote[key];
var pick = local, fromServer = false;
if (remote && (!local || remote.updated_at > (local.at || 0))) {
  pick = { text: remote.text, at: remote.updated_at };
  fromServer = true;
}
if (pick && pick.text) {
  ta.value = pick.text;
  sgFoot(fromServer
    ? "Draft from " + sgWhen(pick.at) + ", saved to codecast."
    : "Draft from " + sgWhen(pick.at) + ".");
}
```

### 3. On `input` — keep the local save, add the remote one

```js
ta.addEventListener("input", function () {
  clearTimeout(localTimer);
  localTimer = setTimeout(function () {
    sSet("sg:" + cur.key, JSON.stringify({ text: ta.value, at: Date.now() }));
  }, 300);
  sgSaveRemote(cur.key, ta.value);           /* ← added */
});
```

### 4. On a successful `send()` — clear both copies

```js
sDel("sg:" + cur.key);
sgClearRemote(cur.key);                      /* ← added */
```

### 5. Flush on the way out

```js
window.addEventListener("pagehide", function () {
  if (cur && ta && ta.value) sgFlush(cur.key, ta.value);
});
```

### 6. Re-read drafts when the name changes

```js
document.querySelector(".sg-who").addEventListener("change", sgLoadDrafts);
```

An empty name is fine — it saves under `anonymous` rather than dropping the
draft, so someone who never fills the name field still keeps their work.

## Verifying it

```bash
SLUG=08LgR3kfHe22
curl -s https://convex.codecast.sh/cli/artifacts/draft \
  -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"key\":\"prompt:self-respect\",\"author\":\"Cameron\",\"text\":\"hello\"}"
# {"ok":true,"updated_at":...}

curl -s https://convex.codecast.sh/cli/artifacts/drafts \
  -H 'Content-Type: application/json' -d "{\"slug\":\"$SLUG\",\"author\":\"Cameron\"}"
# {"drafts":[{"key":"prompt:self-respect","text":"hello","updated_at":...}]}

# empty text clears it
curl -s https://convex.codecast.sh/cli/artifacts/draft \
  -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"key\":\"prompt:self-respect\",\"author\":\"Cameron\",\"text\":\"\"}"
# {"ok":true,"cleared":true,...}
```

In the browser: type into a prompt, wait two seconds for the footer to read
"Saved to codecast at …", hard-reload, reopen the same prompt — the text is
back, and the footer says where it came from. Then open the page on a second
machine under the same name and confirm the draft is there too.
