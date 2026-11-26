// Where the dev server hands a signed-out dev origin its session: answered by
// plugins/devSignIn (serve only), asked by lib/devSignIn (dev builds only).
// A leaf with no imports so both the Vite config and the app can load it.
export const DEV_SESSION_PATH = "/__cast/dev-session";
