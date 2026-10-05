// Plain words for the reasons an app connection is refused: the codes our
// connectors return (oauthConnectors.ts, githubApp.ts, googleOAuth.ts,
// whisk.ts) and the OAuth `error` a provider sends back. Every surface that
// shows a refusal reads this one table (the web settings page, every connect
// card, the simple lane, `cast integrations`), so its words name no surface.
//
// Two ways in, because the two sources deserve different trust:
//   describeConnectorError  a reply from an action the person just called.
//                           A known code reads as its sentence, an unknown
//                           code as a generic line, and a sentence (the
//                           not-configured message, a connector's own words)
//                           passes through.
//   describeReturnReason    a reason read from a URL. Anyone can write one, so
//                           only known codes are described and everything else
//                           reads as the generic line; a URL never puts its
//                           own words on screen.

/** The line for any refusal the table does not know. */
export const CONNECTOR_FAILED = "The connection didn't finish. Try again.";

const DECLINED = "You declined the authorization.";
const SIGNED_OUT = "You were signed out. Sign in, then connect again.";

const REASONS: Readonly<Record<string, string>> = {
  installation_failed: "GitHub could not complete the install. Try again.",
  missing_intent: "That install link did not come from Codecast. Start the install from the GitHub card.",
  unknown_intent: "That install link is no longer valid. Start the install again.",
  intent_expired: "The install link expired before it came back. Start it again.",
  intent_already_used: "That install link was already used. Start the install again.",
  not_a_team_member: "You are no longer a member of that team, so the install has nowhere to bind.",
  install_not_authorized: "GitHub did not confirm who you are. Start the install again and approve the authorization step.",
  installer_does_not_control_installation:
    "That installation belongs to an account you do not administer on GitHub.",
  install_verification_unconfigured:
    "This deployment cannot verify GitHub installs yet (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET).",
  install_verification_failed: "GitHub could not be reached to verify the install. Try again.",
  install_not_fresh:
    "That GitHub installation existed before this install started. Uninstall the Codecast app on GitHub, then install it again from the GitHub card.",
  not_authorized: "You no longer have access to that workspace, so the connection was not activated.",
  not_a_member: "You are no longer a member of that workspace.",
  not_the_owner: "Only the person who made this connection can remove it.",
  wrong_user: "Only the person who started this connection can finish it.",
  denied: DECLINED,
  // The OAuth `error` a provider sends back when the person clicks Cancel.
  access_denied: DECLINED,
  bad_state: "The sign-in link expired before it came back. Start the connection again.",
  expired: "The confirmation link expired. Start the connection again.",
  no_such_installation: "That connection no longer exists. Start it again.",
  signed_out: SIGNED_OUT,
  bad_token: "That confirmation link doesn't match this connection. Connect again.",
  wrong_account:
    "That connection was started from a different account, so it was discarded and the grant revoked. Connect again from this account.",
  confirm_failed: "The connection couldn't be confirmed. Connect again.",
  exchange_failed: "Google didn't finish the sign-in. Connect again.",
  profile_failed: "Google didn't say which account was connected. Connect again.",
  store_failed: "The connection couldn't be saved. Connect again.",
  no_refresh_token:
    "Google didn't grant lasting access. Remove Codecast from your Google account's third-party access, then connect again.",
  whisk_not_configured: "Connecting mail and calendar isn't switched on here yet.",
  whisk_invalid_grant: "That approval from Whisk expired or was already used. Connect again.",
  whisk_invalid_client: "Whisk didn't recognize this server, so the connection didn't finish. Try again later.",
  whisk_unreachable: "Whisk couldn't be reached. Try again in a little while.",
};

/** The table's own sentence for `reason`, or null. Only the table's own keys
 *  count, so `__proto__` or `constructor` never match an inherited member. */
function known(reason: string): string | null {
  return Object.prototype.hasOwnProperty.call(REASONS, reason) ? REASONS[reason] : null;
}

/** A reason shaped like a code (`invalid_scope`). Shown verbatim it would
 *  read as a crash. */
const CODE_SHAPED = /^[a-z][a-z0-9_]*$/;

/** Describe the error an action replied with. */
export function describeConnectorError(reason: string): string {
  return known(reason) ?? (CODE_SHAPED.test(reason) ? CONNECTOR_FAILED : reason);
}

/** Describe a reason read from a URL: a known code, or the generic line. */
export function describeReturnReason(reason: string | null | undefined): string {
  return (reason && known(reason)) || CONNECTOR_FAILED;
}
