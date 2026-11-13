// Docs shots mode (./flag): runs before the app boots. Signs the window in as
// the Acme world's Alex Rivera with a token no server ever sees, hands the app
// the offline Convex client, picks the theme from the address, and seeds the
// store. Persistence is off in this mode (store/idbCache.ts), so nothing is
// read from or written to IndexedDB, and every write the app dispatches lands
// on the stub, which resolves it without a network.
//
//   ?shots-theme=dark      Fjord dark (default: Verdigris light), Modern style

import { DEFAULT_COLOR_THEME } from "../theme/colorTheme";
import { AUTH_JWT_STORAGE_KEY } from "../localAuth";
import { durableAuthStorage } from "../durableAuthStorage";
import { createLocalAuth } from "@platform/auth/web";
import { ACME_CONVEX_ADDRESS, createAcmeConvex } from "../acmeWorld/convexStub";
import { DOCS_ANSWERS } from "./answers";
import { setDocsShotsConvex } from "./flag";

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
/** Shaped like a Convex Auth access token so the principal tracker names the fixture viewer; never signed, never sent. */
const FIXTURE_TOKEN = [b64({ alg: "RS256", typ: "JWT" }), b64({ aud: "convex", iss: "https://shots.invalid", sub: "hero-u-me|docs-shots", exp: 4102444800 }), "docs-shots"].join(".");

const theme = new URLSearchParams(location.search).get("shots-theme") === "dark" ? "dark" : "light";
localStorage.setItem("codecast-theme", theme);
localStorage.setItem("codecast-modern-style", "1");
localStorage.removeItem("codecast-visual-style");
// Under both namespaces: the app's local signal reads the deployment URL's
// (lib/localAuth), Convex Auth reads the stub client's address.
for (const key of [AUTH_JWT_STORAGE_KEY, createLocalAuth(ACME_CONVEX_ADDRESS).jwtKey]) durableAuthStorage.setItem(key, FIXTURE_TOKEN);

setDocsShotsConvex(createAcmeConvex(DOCS_ANSWERS));

const { seedDocsShots } = await import("./seed");
seedDocsShots({ theme, modern_style: true, color_theme: DEFAULT_COLOR_THEME });
