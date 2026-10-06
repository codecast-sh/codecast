// The runtime boundary an app version is written against (SPEC "Runtime"):
// static files served under /run/<slug>/v/<n>/, one pinned React from esm.sh
// shared by the app and the SDK, and the SDK at /run/sdk.js imported as
// "playground". The seed, the builder's prompt and the SDK implementation all
// read this file, so the contract has one home.

export const REACT_VERSION = "19.1.0";
export const SDK_SPECIFIER = "playground";
export const SDK_PATH = "/run/sdk.js";

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

  import { useCollection, useShared, usePresence, me } from "${SDK_SPECIFIER}";

  const { docs, insert, update, remove } = useCollection("notes");
    // docs: live array of the stored objects, each with _id, _by (who wrote it:
    // { id, name, avatar }) and _at (ms), oldest first.
    // insert(obj) -> Promise<_id>; update(_id, patch); remove(_id).
  const [value, setValue] = useShared("score", 0);
    // one live value for everyone; setValue(next) or setValue(prev => next).
  const { people, setMyState } = usePresence();
    // people: who is in the app now, [{ id, name, avatar, isMe, state }];
    // setMyState(obj) shares small per-person state (a cursor, a pick).
  me // { id, name, avatar }: the current visitor; avatar is an image URL.

Data is scoped to this app and survives new versions. Never ask for passwords,
payment details or other secrets.`;
