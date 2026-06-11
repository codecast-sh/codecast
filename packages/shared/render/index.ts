// Shared cross-client RENDER logic: pure tool classification + display
// formatting that the web and mobile session views both need. The single source
// of truth that ends the web↔mobile hand-fork drift.
//
// PURE & isomorphic — NO React/JSX, NO document/window/import.meta, NO Node/DOM
// APIs — so it imports cleanly into both the vite browser bundle and the
// Expo/Hermes (React Native) bundle. Exposed via the `@codecast/shared/render`
// subpath ONLY; deliberately NOT re-exported from the package root or from
// @codecast/shared/contracts so the Convex runtime never pulls render logic.
export * from "./toolNames";
export * from "./format";
export * from "./toolCall";
export * from "./toolVisual";
