// The HMR-stable capture-phase keydown listener now lives in @platform/keys
// (same window slot, so an in-flight HMR session hands off cleanly).
export { setShortcutHandler } from "@platform/keys";
