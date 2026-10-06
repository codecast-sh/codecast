// The postMessage protocol between the shell and an app's SDK. The app runs in
// a sandboxed iframe on another site (an opaque origin, convex/http.ts), so
// this channel is the only thing the two share. Both sides import this module.
//
//   app -> shell  ready           the SDK loaded and waits for init (resent
//                                 until it arrives, so a slow shell is fine)
//   shell -> app  init            who is here and how to reach the backend
//   shell -> app  pick            point and talk on or off, with the look
//   app -> shell  picked          the element the person clicked; picking ends
//   app -> shell  pick-cancelled  Esc inside the app; picking ends
//   app -> shell  error           an uncaught error or rejection in the app
//
// The shell answers `ready` with `init` for every iframe it owns, including a
// preloaded next version. Messages are matched by `event.source` (the shell's
// iframe window, the app's parent), never by origin: the app's origin is
// "null", so the shell posts with targetOrigin "*". Nothing posted here may
// carry the visitor secret, because app code can read everything the SDK
// holds; `init` carries a runtime token good for this one app's data only
// (convex/lib/identity runtimeToken).
import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { runtimeTokenForSecret } from "../convex/lib/identity";
import type { ElementFields } from "../convex/lib/room";

export const PROTOCOL = "clayground/1";

export type PublicVisitorWire = { id: string; avatar: AvatarKey; name: string };

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
  /** An image URL for every avatar key, for `me` and people's faces. The app
   *  is a public https page, so Chrome refuses http://localhost images there:
   *  send https URLs, or data: URLs (all 24 faces are ~165 KB) in dev. */
  avatars: Record<AvatarKey, string>;
};

export type ShellMessage =
  | InitMessage
  | { protocol: typeof PROTOCOL; type: "pick"; on: boolean; theme?: PickTheme };

export type AppMessage =
  | { protocol: typeof PROTOCOL; type: "ready" }
  | { protocol: typeof PROTOCOL; type: "picked"; element: ElementFields }
  | { protocol: typeof PROTOCOL; type: "pick-cancelled" }
  | { protocol: typeof PROTOCOL; type: "error"; message: string };

type Body<M> = M extends unknown ? Omit<M, "protocol"> : never;

function isOurs(data: unknown): data is { protocol: string; type: string } {
  return typeof data === "object" && data !== null && (data as { protocol?: unknown }).protocol === PROTOCOL;
}

export function isShellMessage(data: unknown): data is ShellMessage {
  return isOurs(data) && (data.type === "init" || data.type === "pick");
}

export function isAppMessage(data: unknown): data is AppMessage {
  return isOurs(data) && ["ready", "picked", "pick-cancelled", "error"].includes(data.type);
}

/** Post to an app's iframe window. */
export function postToApp(target: Window, message: Body<ShellMessage>): void {
  target.postMessage({ protocol: PROTOCOL, ...message }, "*");
}

/** Post to the shell (the app's parent). */
export function postToShell(message: Body<AppMessage>): void {
  if (window.parent !== window) window.parent.postMessage({ protocol: PROTOCOL, ...message }, "*");
}

/** The shell's `init` for one app, derived from the visitor's own
 *  credentials without a round trip. */
export async function initFor(
  creds: { visitor_id: string; secret: string },
  appId: string,
  visitor: PublicVisitorWire,
  avatars: Record<AvatarKey, string>,
): Promise<Body<InitMessage>> {
  const token = await runtimeTokenForSecret(creds.secret, appId);
  return { type: "init", app_id: appId, visitor_id: creds.visitor_id, token, visitor, avatars };
}
