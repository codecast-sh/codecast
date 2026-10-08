// The postMessage protocol between the shell and an app's SDK. The app runs in
// a sandboxed iframe on another site (an opaque origin, convex/http.ts), so
// this channel is the only thing the two share. Both sides import this module.
//
//   app -> shell  ready           the SDK loaded and waits for init (resent
//                                 until it arrives, so a slow shell is fine),
//                                 with the version its page is
//   shell -> app  hold            the shell is here, and init follows once it
//                                 knows who you are: wait for it
//   shell -> app  init            who is here and how to reach the backend
//   app -> shell  painted         the app has drawn itself with its data: the
//                                 shell reveals a new version on this, not on
//                                 the iframe's load
//   shell -> app  spotlight       a version just landed: ring the element its
//                                 change is about for a moment
//   app -> shell  spotlit         whether that element was on screen to ring
//   shell -> app  token           a fresh runtime token before the last expires
//   shell -> app  pick            point and talk on or off, with the look
//   app -> shell  picked          the element the person clicked; picking ends
//   app -> shell  pick-cancelled  Esc inside the app; picking ends
//   app -> shell  error           an uncaught error or rejection in the app
//   app -> shell  refused         the app tried to write while looking only
//   shell -> app  capture         draw yourself at this size for the gallery
//   app -> shell  captured        the picture, or null when it failed
//
// The shell answers `ready` with `init` once per page its iframe loads,
// including a preloaded next version. Messages are matched by `event.source`
// (the shell's iframe window, the app's parent), never by origin: the app's
// origin is "null", so the shell posts with targetOrigin "*", and a frame
// that navigates itself away is pointed back at its version before it is
// answered again. Nothing posted here may carry the visitor secret, because
// app code can read everything the SDK holds; `init` carries a short-lived
// runtime token good for this one app's data and the version on screen only
// (convex/lib/identity runtimeToken). A frame that is only looked at (a
// gallery preview, a past version) gets a watch token: it reads, and writes
// nothing; the SDK follows the scope of the token it holds.
import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { runtimeTokenForSecret, type TokenScope } from "../convex/lib/identity";
import type { ElementFields } from "../convex/lib/room";

export { PROTOCOL } from "../convex/lib/bootCatcher";
import { PROTOCOL } from "../convex/lib/bootCatcher";

export type PublicVisitorWire = { id: string; avatar: AvatarKey; name: string };

/** The app as people reach it: its name, its clean link and its room's link
 *  on the shell. The app's own address is the runtime's, never shareable. */
export type AppLink = { name: string; link: string; room: string };

/** How the picker draws, from the shell's tokens, so it matches the room. */
export type PickTheme = { accent: string; ink: string; font: string };

export type InitMessage = {
  protocol: typeof PROTOCOL;
  type: "init";
  app_id: string;
  visitor_id: string;
  token: string;
  /** The visitor as of now; the SDK keeps it live from the backend after. */
  visitor: PublicVisitorWire;
  app: AppLink;
  /** An image URL for every avatar key, for `me` and people's faces. The app
   *  is a public https page, so Chrome refuses http://localhost images there:
   *  send https URLs, or data: URLs (all 24 faces are ~165 KB) in dev. */
  avatars: Record<AvatarKey, string>;
};

export type ShellMessage =
  | InitMessage
  | { protocol: typeof PROTOCOL; type: "hold" }
  | { protocol: typeof PROTOCOL; type: "token"; token: string }
  | { protocol: typeof PROTOCOL; type: "pick"; on: boolean; theme?: PickTheme }
  | { protocol: typeof PROTOCOL; type: "spotlight"; selector: string; color: string }
  | { protocol: typeof PROTOCOL; type: "capture"; width: number; height: number };

export type AppMessage =
  /** `version`: the one its page is, which a page opened at an app's live
   *  link only learns once it arrives. */
  | { protocol: typeof PROTOCOL; type: "ready"; version: number | null }
  | { protocol: typeof PROTOCOL; type: "painted" }
  | { protocol: typeof PROTOCOL; type: "spotlit"; found: boolean }
  | { protocol: typeof PROTOCOL; type: "picked"; element: ElementFields }
  | { protocol: typeof PROTOCOL; type: "pick-cancelled" }
  | { protocol: typeof PROTOCOL; type: "error"; message: string }
  | { protocol: typeof PROTOCOL; type: "refused" }
  | { protocol: typeof PROTOCOL; type: "captured"; image: Blob | null };

type Body<M> = M extends unknown ? Omit<M, "protocol"> : never;

function isOurs(data: unknown): data is { protocol: string; type: string } {
  return typeof data === "object" && data !== null && (data as { protocol?: unknown }).protocol === PROTOCOL;
}

export function isShellMessage(data: unknown): data is ShellMessage {
  return isOurs(data) && ["init", "hold", "token", "pick", "spotlight", "capture"].includes(data.type);
}

export function isAppMessage(data: unknown): data is AppMessage {
  return isOurs(data) && ["ready", "painted", "spotlit", "picked", "pick-cancelled", "error", "refused", "captured"].includes(data.type);
}

/** Post to an app's iframe window. */
export function postToApp(target: Window, message: Body<ShellMessage>): void {
  target.postMessage({ protocol: PROTOCOL, ...message }, "*");
}

/** Post to the shell (the app's parent). */
export function postToShell(message: Body<AppMessage>): void {
  if (window.parent !== window) window.parent.postMessage({ protocol: PROTOCOL, ...message }, "*");
}

/** The shell's `init` for one version of an app, derived from the
 *  visitor's own credentials without a round trip. */
export async function initFor(opts: {
  creds: { visitor_id: string; secret: string };
  appId: string;
  version: number;
  visitor: PublicVisitorWire;
  avatars: Record<AvatarKey, string>;
  app: AppLink;
  scope?: TokenScope;
}): Promise<Body<InitMessage>> {
  const { creds, appId, version, visitor, avatars, app, scope = "use" } = opts;
  const token = await runtimeTokenForSecret(creds.secret, appId, version, Date.now(), scope);
  return { type: "init", app_id: appId, visitor_id: creds.visitor_id, token, visitor, avatars, app };
}
