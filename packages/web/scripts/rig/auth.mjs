// How a headless page becomes a signed in person on a deployment.
//
// Tokens are minted server side with the auth library's own `auth:store`
// (type signIn, generateTokens) through an admin client on the deployment
// (stack.mjs), and put in localStorage under the keys @convex-dev/auth reads,
// named for the CONVEX origin (https://convex.codecast.sh becomes
// httpsconvexcodecastsh), never the web origin. The page has to be ON the app
// origin before the keys are set, so the rig opens a page first, sets them,
// then opens the app.
//
// Which deployment is the caller's choice, and stack.mjs decides which ones
// exist: the smoke suite signs its seeded test identities into the local
// deployment; the face row rig signs the App Review demo accounts below into
// prod, and only under RIG_DEPLOYMENT=prod.
import { adminClient, prodDeployment } from "./stack.mjs";

// The face row rig's fixtures: the Apple App Review demo accounts in the team
// "Codecast Review" on prod, the one team with calls on. A reviewer signs into
// these, so a run leaves no message and no changed preference behind
// (endWalkie and leaveCall on every exit; the flows send no text).
export const IDENTITIES = {
  riley: { id: "kd777ypck8b0bzxzgs8cq9rqg9894p29", name: "Riley Chen", port: 9611 },
  jordan: { id: "kd764edpkn8344ffz3fpgen8418cvdt7", name: "Jordan Lee", port: 9612 },
};

/** The deployment the face row rig runs on (calls need prod's LiveKit). */
export const faceRigDeployment = () => prodDeployment("The face row rig");

function storageSuffix(url) {
  return url.replace(/[^a-zA-Z0-9]/g, "");
}

/** Mint a signed in session for a user id on a deployment: { token, refreshToken }. */
export async function mintTokens(dep, userId) {
  const out = await adminClient(dep).mutation("auth:store", { args: { type: "signIn", userId, generateTokens: true } });
  if (!out?.tokens?.token) throw new Error(`auth:store answered without tokens: ${JSON.stringify(out).slice(0, 200)}`);
  return out.tokens;
}

/** The statement that installs a minted session in the page's localStorage. */
export function installTokensJs(tokens, convexUrl) {
  const s = storageSuffix(convexUrl);
  return `(() => {
    localStorage.setItem(${JSON.stringify(`__convexAuthJWT_${s}`)}, ${JSON.stringify(tokens.token)});
    localStorage.setItem(${JSON.stringify(`__convexAuthRefreshToken_${s}`)}, ${JSON.stringify(tokens.refreshToken)});
    // The device setup dialog (permissions/DeviceSetupDialog) opens once per
    // fresh profile and would sit over every shot of the header.
    localStorage.setItem("codecast.deviceSetup.v1", String(Date.now()));
    return "set";
  })()`;
}

/** Sign a page in as a user on a deployment and land it on `path`. */
export async function signIn(page, dep, userId, path = "/inbox") {
  const tokens = await mintTokens(dep, userId);
  await page.navigate(`${dep.appUrl}/login`);
  await page.evaluate(installTokensJs(tokens, dep.convexUrl));
  await page.navigate(`${dep.appUrl}${path}`);
}
