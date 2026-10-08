// End-to-end check of the app runtime against the dev deployment in .env.local:
// serving (routes, headers, caching, transpiled modules, the SDK) and the data
// layer the SDK calls (runtime tokens, stamping, caps, shared value conflicts,
// presence state).
//
//   bun scripts/verify-runtime.ts          run the checks, exit 1 on any failure
//   bun scripts/verify-runtime.ts --serve  then serve a stand-in shell on :5319
//                                          that embeds a fresh app and answers
//                                          its SDK, for a check in a real browser
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MAX_DATA_DOC_BYTES } from "../convex/lib/limits";
import { livePath, versionPath } from "../convex/lib/runPaths";
import { SDK_PATH } from "../convex/lib/runtime";
import { RUNTIME_TOKEN_TTL_MS, runtimeTokenForSecret } from "../convex/lib/identity";
import { PROTOCOL, initFor } from "../runtime/protocol";
import { mintVisitor } from "../src/lib/mint";
import { CLOUD, ROOT, SITE, check, failed } from "./lib/harness";

const HARNESS_PORT = 5319;

const client = new ConvexHttpClient(CLOUD);

async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return (e as { data?: { code?: string } }).data?.code ?? String(e);
  }
}

const get = (path: string, headers: Record<string, string> = {}) => fetch(SITE + path, { headers, redirect: "manual" });

// ---- Two visitors, one app --------------------------------------------------

const register = (args: { secret: string; nonce: number }) => client.mutation(api.visitors.register, args);
const credsA = await mintVisitor(register);
const credsB = await mintVisitor(register);
const app = await client.mutation(api.apps.create, { ...credsA, name: "Runtime check", unlisted: true });
const other = await client.mutation(api.apps.create, { ...credsA, name: "Other app", unlisted: true });
console.log(`app ${app.slug} (${app.app_id})`);

// ---- Serving ----------------------------------------------------------------

{
  const live = await get(livePath(app.slug));
  check("live redirects to the live version's folder", live.status === 302 && live.headers.get("location") === versionPath(app.slug, 1));
  check("live is never cached", live.headers.get("cache-control") === "no-store");

  const folder = await get(`/run/${app.slug}/v/1`);
  check("a folder without its slash redirects to it", folder.status === 301 && folder.headers.get("location") === versionPath(app.slug, 1));

  const index = await get(versionPath(app.slug, 1));
  const csp = index.headers.get("content-security-policy") ?? "";
  const html = await index.text();
  check("index.html is served as HTML", index.status === 200 && index.headers.get("content-type")!.startsWith("text/html"));
  check("the CSP sandboxes without allow-same-origin", csp.startsWith("sandbox allow-scripts") && !csp.includes("allow-same-origin"), csp);
  check("version files cache forever", index.headers.get("cache-control") === "public, max-age=31536000, immutable");
  check("CORS is open for the opaque origin's module fetches", index.headers.get("access-control-allow-origin") === "*");
  check("the import map pins React and the SDK", html.includes(`"react": "https://esm.sh/react@`) && html.includes(`"playground": "${SDK_PATH}"`));

  const etag = index.headers.get("etag")!;
  const again = await get(versionPath(app.slug, 1), { "If-None-Match": etag });
  check("a known ETag answers 304", again.status === 304);

  const appJsx = await get(versionPath(app.slug, 1, "src/App.jsx"));
  const code = await appJsx.text();
  check("JSX is served as JavaScript", appJsx.headers.get("content-type") === "text/javascript; charset=utf-8");
  check("JSX is served transpiled", code.includes(`from "react/jsx-runtime"`) && !code.includes("<main"), code.slice(0, 200));

  const css = await get(versionPath(app.slug, 1, "src/styles.css"));
  check("CSS is served as CSS", css.headers.get("content-type") === "text/css; charset=utf-8");

  const sdk = await get(SDK_PATH);
  const sdkCode = await sdk.text();
  check("the SDK is JavaScript", sdk.status === 200 && sdk.headers.get("content-type") === "text/javascript; charset=utf-8");
  check("the SDK names this deployment", sdkCode.includes(CLOUD) && !sdkCode.includes("__PLAYGROUND_CONVEX_URL__"));
  check("the SDK revalidates", sdk.headers.get("cache-control")!.startsWith("public, max-age=60"));

  for (const [path, why] of [
    [versionPath(app.slug, 99), "a version that does not exist"],
    [versionPath(app.slug, 1, "src/nope.js"), "a file the version lacks"],
    [`/run/${app.slug}/v/1/..%2F..%2Fsdk`, "an escaping path"],
    [versionPath("no-such-app-zzzz", 1), "an unknown app"],
  ] as const) {
    const res = await get(path);
    // The CDN stretches the browser cache of .js/.css URLs, a 404 included;
    // harmless, since a version never gains a file.
    check(`404 for ${why}`, res.status === 404, res.status);
  }
}

// ---- Data layer ---------------------------------------------------------------

const appId = app.app_id as Id<"apps">;
const [meA, meB] = await Promise.all([credsA, credsB].map(async (c) => (await client.query(api.visitors.me, c))!.visitor));
const tokenA = await runtimeTokenForSecret(credsA.secret, appId, 1);
const tokenB = await runtimeTokenForSecret(credsB.secret, appId, 1);
const rtA = { visitor_id: credsA.visitor_id, app_id: appId, token: tokenA };
const rtB = { visitor_id: credsB.visitor_id, app_id: appId, token: tokenB };

{
  check("a token from another app is refused", (await refusal(() => client.query(api.runtime.me, { ...rtA, app_id: other.app_id }))) === "unauthorized");
  check("another visitor's token is refused", (await refusal(() => client.query(api.runtime.me, { ...rtA, token: tokenB }))) === "unauthorized");
  check("the visitor secret is not a runtime token", (await refusal(() => client.query(api.runtime.me, { ...rtA, token: credsA.secret }))) === "unauthorized");
  const expired = await runtimeTokenForSecret(credsA.secret, appId, 1, Date.now() - RUNTIME_TOKEN_TTL_MS - 1_000);
  check("an expired token is refused", (await refusal(() => client.query(api.runtime.me, { ...rtA, token: expired }))) === "unauthorized");
  check("me is the token's visitor", (await client.query(api.runtime.me, rtA)).id === credsA.visitor_id);

  const id = await client.mutation(api.runtime.insert, { ...rtA, collection: "guestbook", value: { text: "hi", _by: "forged" } });
  await client.mutation(api.runtime.insert, { ...rtB, collection: "guestbook", value: { text: "hello" } });
  let docs = await client.query(api.runtime.list, { ...rtB, collection: "guestbook" });
  check("docs list oldest first with their authors stamped by the server", docs.length === 2 && docs[0]._by?.id === credsA.visitor_id && docs[1]._by?.id === credsB.visitor_id && docs[0].text === "hi", docs);

  await client.mutation(api.runtime.update, { ...rtB, id, patch: { likes: 1 } });
  docs = await client.query(api.runtime.list, { ...rtA, collection: "guestbook" });
  check("update merges and keeps the author", docs[0].likes === 1 && docs[0].text === "hi" && docs[0]._by?.id === credsA.visitor_id);

  const big = { s: "x".repeat(MAX_DATA_DOC_BYTES) };
  check("an oversized doc is refused", (await refusal(() => client.mutation(api.runtime.insert, { ...rtA, collection: "guestbook", value: big }))) === "invalid");
  check("a bad collection name is refused", (await refusal(() => client.query(api.runtime.list, { ...rtA, collection: "~shared" }))) === "invalid");
  const foreign = await client.mutation(api.runtime.insert, { ...rtA, app_id: other.app_id, token: await runtimeTokenForSecret(credsA.secret, other.app_id, 1), collection: "x", value: {} });
  check("another app's doc cannot be touched", (await refusal(() => client.mutation(api.runtime.remove, { ...rtA, id: foreign }))) === "not_found");

  await client.mutation(api.runtime.remove, { ...rtA, id });
  check("remove deletes", (await client.query(api.runtime.list, { ...rtA, collection: "guestbook" })).length === 1);

  check("an unset shared value reads null", (await client.query(api.runtime.shared, { ...rtA, key: "waves" })) === null);
  const first = await client.mutation(api.runtime.setShared, { ...rtA, key: "waves", value: 1, base_rev: 0 });
  const stale = await client.mutation(api.runtime.setShared, { ...rtB, key: "waves", value: 1, base_rev: 0 });
  check("a write against a stale rev is refused with the current value", first.ok && !stale.ok && stale.value === 1 && stale.rev === 1, { first, stale });
  const retry = await client.mutation(api.runtime.setShared, { ...rtB, key: "waves", value: 2, base_rev: 1 });
  const shared = await client.query(api.runtime.shared, { ...rtA, key: "waves" });
  check("the retried updater lands: two waves, none lost", retry.ok && shared?.value === 2 && shared.by?.id === credsB.visitor_id, shared);

  for (const round of [1, 2, 2]) await client.mutation(api.runtime.insert, { ...rtA, collection: "strokes", value: { round } });
  const scoped = await client.query(api.runtime.list, { ...rtA, collection: "strokes", where: { round: 2 } });
  check("a where read returns only matching docs", scoped.length === 2 && scoped.every((d) => d.round === 2), scoped);
  const cleared = await client.mutation(api.runtime.removeWhere, { ...rtB, collection: "strokes", where: { round: 2 } });
  const left = await client.query(api.runtime.list, { ...rtA, collection: "strokes" });
  check("removeWhere deletes the matching docs in one write", cleared.removed === 2 && !cleared.more && left.length === 1 && left[0].round === 1, { cleared, left });

  await client.mutation(api.runtime.setShared, { ...rtA, key: "word", mine: true, value: "otter" });
  const mineA = await client.query(api.runtime.shared, { ...rtA, key: "word", mine: true });
  const mineB = await client.query(api.runtime.shared, { ...rtB, key: "word", mine: true });
  check("a private value reads back for its owner only", mineA?.value === "otter" && mineB === null, { mineA, mineB });

  await client.mutation(api.runtime.setState, { ...rtA, state: { x: 0.5 } });
  const people = await client.query(api.runtime.people, rtB);
  check("presence state is shared", people.some((p) => p.visitor.id === credsA.visitor_id && p.state?.x === 0.5), people);
}

console.log(failed() ? `\n${failed()} failed` : "\nall runtime checks passed");
if (failed()) process.exit(1);

// ---- Stand-in shell for the browser check ------------------------------------

if (process.argv.includes("--serve")) {
  const fresh = await client.mutation(api.apps.create, { ...credsA, name: "Browser check", unlisted: true });
  const avatarDir = join(ROOT, "../web/components/org/avatars");
  const dataUrl = async (k: string) => `data:image/webp;base64,${Buffer.from(await Bun.file(join(avatarDir, `${k}.webp`)).arrayBuffer()).toString("base64")}`;
  const avatars = Object.fromEntries(await Promise.all(AVATAR_KEYS.map(async (k) => [k, await dataUrl(k)])));
  const init = await initFor({
    creds: credsA,
    appId: fresh.app_id,
    version: 1,
    visitor: meA,
    avatars: avatars as never,
    app: { name: "Browser check", link: `http://localhost:${HARNESS_PORT}/`, room: `http://localhost:${HARNESS_PORT}/?room` },
  });
  const page = `<!doctype html><meta charset="utf-8"><title>Runtime harness</title>
<style>body{margin:0}iframe{border:0;width:100vw;height:100vh;display:block}</style>
<iframe src="${SITE}${versionPath(fresh.slug, 1)}"></iframe>
<script type="module">
  const PROTOCOL = ${JSON.stringify(PROTOCOL)};
  const init = ${JSON.stringify(init)};
  const frame = document.querySelector("iframe");
  window.__log = [];
  window.__pick = (on) => frame.contentWindow.postMessage({ protocol: PROTOCOL, type: "pick", on }, "*");
  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow || e.data?.protocol !== PROTOCOL) return;
    window.__log.push(e.data);
    if (e.data.type === "ready") frame.contentWindow.postMessage({ protocol: PROTOCOL, ...init }, "*");
  });
</script>`;
  Bun.serve({ port: HARNESS_PORT, fetch: () => new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } }) });
  console.log(`\nstand-in shell: http://localhost:${HARNESS_PORT}/  (app ${fresh.slug}, ${fresh.app_id})`);
  console.log(`verify data with: visitor ${credsA.visitor_id}, token ${init.token}`);
}
