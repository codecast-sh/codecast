// Dev builds only (src/main.tsx loads it under import.meta.env.DEV, so a
// production bundle never contains it). A signed-out dev origin asks its own
// dev server for a session (plugins/devSignIn) before the app boots, so an
// agent opening the URL `cast dev` printed lands signed in (ct-101742).
//
// Sign-in pages are left alone, so the signed-out flows stay testable: sign
// out, and /login stays signed out until you open an app page again.
import { DEV_SESSION_PATH } from "./devSessionPath";
import { AUTH_JWT_STORAGE_KEY, AUTH_REFRESH_TOKEN_STORAGE_KEY } from "./localAuth";
import { durableAuthStorage, readDurableAuthValue } from "./durableAuthStorage";
import { markDeviceSetupSeen } from "./deviceSetup";

const SIGNED_OUT_PAGES = /^\/(login|signup|forgot-password|reset-password|auth|oauth)(\/|$)/;

export async function signInDevOrigin(): Promise<void> {
  if (SIGNED_OUT_PAGES.test(location.pathname)) return;
  try {
    if (await readDurableAuthValue(AUTH_JWT_STORAGE_KEY)) return;
    const res = await fetch(DEV_SESSION_PATH, { method: "POST" });
    const body = await res.json();
    if (!res.ok) return void console.info(`[dev sign-in] signed out: ${body.error}`);
    durableAuthStorage.setItem(AUTH_JWT_STORAGE_KEY, body.token);
    durableAuthStorage.setItem(AUTH_REFRESH_TOKEN_STORAGE_KEY, body.refreshToken);
    // A dev origin is not a new device: no "Set up this browser" over the page.
    markDeviceSetupSeen();
  } catch (e) {
    console.info("[dev sign-in] signed out:", e);
  }
}
