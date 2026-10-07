// The runtime boundary an app version is written against (SPEC "Runtime"):
// static files served under /run/<slug>/v/<n>/, one pinned React from esm.sh
// shared by the app and the SDK, and the SDK at /run/sdk imported as
// "playground". The seed, the builder's prompt and the SDK implementation all
// read this file, so the contract has one home.
import { DATA_LIST_MAX, DATA_WHERE_FIELDS_MAX, MAX_DATA_DOCS_PER_APP, RATE } from "./limits";

export const REACT_VERSION = "19.1.0";
export const SDK_SPECIFIER = "playground";
/** No file extension on purpose: the CDN in front of .convex.site stretches
 *  the browser cache of .js and .css URLs to hours whatever the origin says,
 *  which is right for immutable version files and wrong for the SDK. */
export const SDK_PATH = "/run/sdk";

/** Every runtime response's CSP: a sandbox without allow-same-origin, so an
 *  app is an opaque origin even when opened on its own. */
export const RUNTIME_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";

/** The served SDK names its deployment here; the router fills it in. */
export const CONVEX_URL_PLACEHOLDER = "__PLAYGROUND_CONVEX_URL__";

/** An npm package from esm.sh that shares the app's React rather than
 *  bundling its own. */
export function esmUrl(pkg: string): string {
  return `https://esm.sh/${pkg}?external=react,react-dom`;
}

export const IMPORT_MAP = {
  imports: {
    react: `https://esm.sh/react@${REACT_VERSION}`,
    "react/jsx-runtime": `https://esm.sh/react@${REACT_VERSION}/jsx-runtime`,
    "react-dom": esmUrl(`react-dom@${REACT_VERSION}`),
    "react-dom/client": esmUrl(`react-dom@${REACT_VERSION}/client`),
    [SDK_SPECIFIER]: SDK_PATH,
  },
};

export function importMapScript(): string {
  return `<script type="importmap">${JSON.stringify(IMPORT_MAP, null, 2)}</script>`;
}

/** What an app may assume, as the builder is told it. */
export const SDK_DOCS = `\
An app is static files: index.html plus ES modules (.js .jsx .ts .tsx), .css,
.json, .svg. JSX and TypeScript are transpiled for you (automatic JSX runtime,
no React import needed). index.html loads CSS with <link> and the entry module
with <script type="module">; use relative paths ("src/main.jsx"). Keep the
import map in index.html: it pins React ${REACT_VERSION} for the app and the SDK.
Other npm packages load from esm.sh: import from "${esmUrl("<name>@<version>")}".

The "${SDK_SPECIFIER}" module gives every app live multiplayer state:

  import { useCollection, useShared, useMine, usePresence, me, app } from "${SDK_SPECIFIER}";

  const { docs, ready, insert, update, remove, removeWhere } = useCollection("notes");
    // docs: live array of the stored objects, each with _id, _by (who wrote it:
    // { id, name, avatar }) and _at (ms), oldest first. At most the newest
    // ${DATA_LIST_MAX} docs; older ones are still stored but not returned.
    // insert(obj) -> Promise<_id>; update(_id, patch) merges; remove(_id).
    // removeWhere({ round: 3 }) deletes every doc matching in one write
    // ({} clears the collection) and resolves to how many went.
  useCollection("strokes", { where: { round } })
    // only docs whose top-level fields equal these (up to ${DATA_WHERE_FIELDS_MAX} fields, string,
    // number, boolean or null values); the ${DATA_LIST_MAX} are counted after the filter.
  const [value, setValue, ready] = useShared("score", 0);
    // one live value for everyone. setValue(prev => next) applies on top of
    // whatever others wrote meanwhile (it retries on a conflict), so use it
    // whenever the next value depends on the current one; setValue(next)
    // overwrites. Many people adding things: prefer a collection.
  const [word, setWord, ready] = useMine("word", null);
    // like useShared, but the current person's own: kept for them across
    // reloads and new versions, and never shown to anyone else by the SDK.
  const { people, setMyState } = usePresence();
    // people: who is in the app now, [{ id, name, avatar, isMe, state }];
    // setMyState(obj) shares small per-person state (a cursor, a pick).
  me  // { id, name, avatar }: the current visitor; avatar is an image URL.
  app // { name, link, room }: the app's shareable link and its room's link.

Where state goes: what everyone should see lives in a collection or useShared;
what is one person's and private (their secret word, their hand of cards, a
draft, their own pick) lives in useMine; what is one person's and fleeting
(a cursor, a drag in progress) goes through setMyState. React state alone is
lost on reload.

Data arrives a moment after the first render. Until \`ready\` is true, docs is
empty and a shared value is its initial, so render a quiet placeholder rather
than an empty state or a zero, and make one-time writes (register me, seed
starting content) in an effect once ready is true, checking what is already
there; never on a timer.

Each person can write ${RATE.dataWrite.max} times a minute (insert, update, remove,
removeWhere and setValue each count once); bursts are fine within that. So
write once per gesture (on release, on submit), never on every pointer move
or frame: keep a gesture in progress local, and share it live through
setMyState when others should watch it happen. Clear many docs with
removeWhere, not one remove each.

An app holds at most ${MAX_DATA_DOCS_PER_APP} docs in all; past that inserts are refused.
Data that only matters for a while (strokes, guesses, a round's moves)
carries its round or session in a field, is read with where, and is cleared
with removeWhere when the round ends. A refused write rejects with a readable
message, and the room is told; never swallow write errors with an empty
catch.

Every app's room already has a Copy link button. An in-app invite is
optional; when there is one, it shares app.link (never location.href or
document.referrer, which are the runtime's address, not the app's).

Data is scoped to this app and survives new versions. Never ask for passwords,
payment details or other secrets.`;
