// The two identities and how a headless page becomes one of them.
//
// The fixtures are the Apple App Review demo accounts in the team "Codecast
// Review", the one team with calls on: Riley Chen and Jordan Lee. A reviewer
// signs into these, so a run leaves no message and no changed preference
// behind (endWalkie and leaveCall on every exit; the flows send no text).
//
// Tokens are minted server side with the auth library's own `auth:store`
// (type signIn, generateTokens), through the self hosted deployment, and put
// in localStorage under the keys @convex-dev/auth reads, named for the CONVEX
// origin (https://convex.codecast.sh becomes httpsconvexcodecastsh), never
// the web origin. The page has to be ON the app origin before the keys are
// set, so the rig opens a page first, sets them, then opens the app.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONVEX_DIR = resolve(HERE, "../../../convex");
export const CONVEX_URL = process.env.CONVEX_SELF_HOSTED_URL || "https://convex.codecast.sh";
export const APP_URL = process.env.RIG_APP_URL || "http://localhost:3200";

export const IDENTITIES = {
  riley: { id: "kd777ypck8b0bzxzgs8cq9rqg9894p29", name: "Riley Chen", port: 9611 },
  jordan: { id: "kd764edpkn8344ffz3fpgen8418cvdt7", name: "Jordan Lee", port: 9612 },
};

function storageSuffix(url) {
  return url.replace(/[^a-zA-Z0-9]/g, "");
}

/** Mint a signed in session for a user id: { token, refreshToken }. */
export function mintTokens(userId) {
  const env = { ...process.env };
  delete env.CONVEX_DEPLOYMENT;
  env.CONVEX_SELF_HOSTED_URL = CONVEX_URL;
  const out = execFileSync(
    "npx",
    ["convex", "run", "auth:store", JSON.stringify({ args: { type: "signIn", userId, generateTokens: true } })],
    { cwd: CONVEX_DIR, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const json = JSON.parse(out.slice(out.indexOf("{")));
  if (!json?.tokens?.token) throw new Error(`auth:store answered without tokens: ${out.slice(0, 200)}`);
  return json.tokens;
}

/** The statement that installs a minted session in the page's localStorage. */
export function installTokensJs(tokens, convexUrl = CONVEX_URL) {
  const s = storageSuffix(convexUrl);
  return `(() => {
    localStorage.setItem(${JSON.stringify(`__convexAuthJWT_${s}`)}, ${JSON.stringify(tokens.token)});
    localStorage.setItem(${JSON.stringify(`__convexAuthRefreshToken_${s}`)}, ${JSON.stringify(tokens.refreshToken)});
    return "set";
  })()`;
}

/** Sign a page in as `who` and land it on the app. */
export async function signIn(page, who) {
  const tokens = mintTokens(IDENTITIES[who].id);
  await page.navigate(`${APP_URL}/login`);
  await page.evaluate(installTokensJs(tokens));
  await page.navigate(`${APP_URL}/inbox`);
}
