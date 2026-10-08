// The real runtime SDK (runtime/sdk.ts) against the dev deployment, the way
// an app sees it: each "page" is a fresh process with happy-dom, a stand-in
// shell that answers the SDK's `ready` with a real `init`, and a small React
// app reading the hooks. Checks what the builder is promised in SDK_DOCS:
// the ready flags, app.link, useMine across a reload and between people,
// where reads and removeWhere, a refused write told to the shell once, and
// a looking-only page whose writes stay quiet for the app.
//
//   bun scripts/verify-sdk.ts   exit 1 on any failure
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MAX_DATA_DOC_BYTES } from "../convex/lib/limits";
import { initFor, type AppLink, type InitMessage } from "../runtime/protocol";
import { CLOUD, check, failed, visitor, type Visitor } from "./lib/harness";

type Page = { init: Omit<InitMessage, "protocol">; act: "first" | "reload" | "other" | "watch" };
type Seen = {
  firstRender: { notesReady: boolean; mineReady: boolean; notes: number };
  ready: { notes: number; word: unknown; scoped: number };
  link: AppLink;
  removed?: number;
  afterRemove?: number;
  /** Looking only: how a write settled for the app, and what the shell heard. */
  watchWrite?: string;
  refusals?: number;
  shellErrors: string[];
};

// ---- One page (child process) ---------------------------------------------------

if (process.argv[2] === "--page") {
  const page: Page = JSON.parse(process.argv[3]);
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register({ url: "https://run.clayground.test/", width: 800, height: 600 });
  process.env.PLAYGROUND_CONVEX_URL = CLOUD;

  const shellErrors: string[] = [];
  let refusals = 0;
  const shell = {
    postMessage(message: { type: string; message?: string }) {
      if (message.type === "refused") refusals++;
      if (message.type === "ready") setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { protocol: "clayground/1", ...page.init }, source: shell as never })));
      if (message.type === "error") shellErrors.push(message.message!);
    },
  };
  Object.defineProperty(window, "parent", { value: shell, configurable: true });

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const sdk = await import("../runtime/sdk");
  const seen: Partial<Seen> = { shellErrors, link: sdk.app };
  let notes: ReturnType<typeof sdk.useCollection> | null = null;
  let scoped: ReturnType<typeof sdk.useCollection> | null = null;
  let mine: ReturnType<typeof sdk.useMine<string | null>> | null = null;

  function App() {
    notes = sdk.useCollection("notes");
    scoped = sdk.useCollection("notes", { where: { round: 2 } });
    mine = sdk.useMine<string | null>("word", null);
    seen.firstRender ??= { notesReady: notes.ready, mineReady: mine[2], notes: notes.docs.length };
    return null;
  }
  document.body.innerHTML = '<div id="root"></div>';
  createRoot(document.getElementById("root")!).render(React.createElement(App));

  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  await until(() => !!notes?.ready && !!scoped?.ready && !!mine?.[2]);

  if (page.act === "first") {
    for (const round of [1, 2, 2]) await notes!.insert({ round });
    await mine![1]("otter");
    await until(() => scoped!.docs.length === 2 && mine![0] === "otter");
  }
  seen.ready = { notes: notes!.docs.length, word: mine![0], scoped: scoped!.docs.length };
  if (page.act === "reload") {
    seen.removed = await notes!.removeWhere({ round: 2 });
    await until(() => notes!.docs.length === 1);
    seen.afterRemove = notes!.docs.length;
    // A refused write: rejects for the app, and the shell hears it once.
    await notes!.insert({ s: "x".repeat(MAX_DATA_DOC_BYTES) }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  }
  if (page.act === "watch") {
    const settled = notes!.insert({ round: 3 }).then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
    seen.watchWrite = await Promise.race([settled, new Promise<string>((r) => setTimeout(() => r("quiet"), 1_000))]);
    seen.refusals = refusals;
  }
  console.log(`SEEN ${JSON.stringify(seen)}`);
  process.exit(0);
}

// ---- The check (parent) ------------------------------------------------------------

const avatars = Object.fromEntries(AVATAR_KEYS.map((k) => [k, `https://avatars.test/${k}.webp`])) as Record<(typeof AVATAR_KEYS)[number], string>;
const A = await visitor();
const B = await visitor();
const made = await A.client.mutation(api.apps.create, { ...A.creds, name: "SDK check", unlisted: true });
const appId = made.app_id as Id<"apps">;
const link: AppLink = { name: "SDK check", link: `https://clayground.test/${made.slug}`, room: `https://clayground.test/${made.slug}?room` };

async function open(who: Visitor, act: Page["act"]): Promise<Seen> {
  const me = (await who.client.query(api.visitors.me, who.creds))!.visitor;
  const init = await initFor({ creds: who.creds, appId, version: 1, visitor: me, avatars, app: link, scope: act === "watch" ? "watch" : "use" });
  const proc = Bun.spawn(["bun", import.meta.path, "--page", JSON.stringify({ init, act })], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const line = out.split("\n").find((l) => l.startsWith("SEEN "));
  if (!line) throw new Error(`page ${act} said nothing: ${out.slice(-400)} ${(await new Response(proc.stderr).text()).slice(-800)}`);
  return JSON.parse(line.slice(5));
}

const first = await open(A, "first");
check("before the first answer, a collection and a private value say not ready", !first.firstRender.notesReady && !first.firstRender.mineReady, first.firstRender);
check("app is the shell's clean link, not the runtime's address", first.link.link === link.link && first.link.room === link.room, first.link);
check("a where read holds only matching docs", first.ready.scoped === 2 && first.ready.notes === 3, first.ready);

const reload = await open(A, "reload");
check("useMine survives a reload for its owner", reload.ready.word === "otter", reload.ready);
check("removeWhere removes every match and the live list follows", reload.removed === 2 && reload.afterRemove === 1, reload);
check(
  "a refused write is told to the shell once",
  reload.shellErrors.length === 1 && reload.shellErrors[0].startsWith("A write was refused:"),
  reload.shellErrors,
);

const other = await open(B, "other");
check("another person never sees someone's private value", other.ready.word === null, other.ready);

const watch = await open(B, "watch");
check("looking only, a write neither fails nor succeeds for the app", watch.watchWrite === "quiet", watch.watchWrite);
check("looking only, the shell hears the refusal and no app error", watch.refusals === 1 && watch.shellErrors.length === 0, watch);
check("looking only, the app still reads the shared data", watch.ready.notes === 1, watch.ready);

await Promise.all([A.client.close(), B.client.close()]);
console.log(failed() ? `\n${failed()} failed` : "\nall SDK checks passed");
process.exit(failed() ? 1 : 0);
