// Load the render gallery (lib/renderGallery.ts) into the conversation that is
// open, to look at every kind of transcript row at once. The rows go into the
// local store only (applyTailMessages, a sync write): nothing reaches the
// server. They can sit in the local cache until the conversation's next server
// load replaces them, so `--clear` takes them out.
//
//   bun packages/web/scripts/render-gallery.ts --web              # your cast browser tab (open a conversation first)
//   bun packages/web/scripts/render-gallery.ts --mobile [port]    # the app on a simulator, through Metro (default 8095)
//   bun packages/web/scripts/render-gallery.ts --print            # the expression, for a console
//   ... --conversation <id>   pick the conversation (default: the open one, else the first loaded)
//   ... --clear               remove the gallery rows instead
import { spawnSync } from "child_process";
import { join } from "path";
import { renderGalleryMessages, GALLERY_ID_PREFIX } from "../lib/renderGallery";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};

const rows = flag("--clear") ? [] : renderGalleryMessages(Date.now());
const expression = `(() => {
  const store = globalThis.__inboxStore;
  if (!store) return "no __inboxStore in this page";
  const s = store.getState();
  const id = ${JSON.stringify(value("--conversation") ?? null)} || s.currentSessionId || Object.keys(s.messages)[0];
  if (!id) return "open a conversation first";
  const kept = (s.messages[id] || []).filter((m) => !String(m._id).startsWith(${JSON.stringify(GALLERY_ID_PREFIX)}));
  const rows = ${JSON.stringify(rows)};
  store.getState().applyTailMessages(id, 0, [...kept, ...rows], null);
  return id + ": " + (rows.length ? rows.length + " gallery rows" : "gallery cleared");
})()`;

function run(cmd: string, argv: string[]): string {
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

if (flag("--print")) {
  console.log(expression);
} else if (flag("--web")) {
  console.log(run("cast", ["browser", "eval", expression]));
} else if (flag("--mobile")) {
  const port = value("--mobile") ?? "8095";
  const targets: Array<{ webSocketDebuggerUrl: string }> = await (await fetch(`http://localhost:${port}/json`)).json();
  const evalScript = join(import.meta.dir, "../../mobile/scripts/hermes-eval.mjs");
  // A dev client lists more than one page; the app's runtime is the one with the store.
  for (const t of targets) {
    let out = "";
    try { out = run("bun", [evalScript, t.webSocketDebuggerUrl, expression, "10000"]); } catch { continue; }
    if (out.includes('"value"') && !out.includes("no __inboxStore")) {
      console.log(JSON.parse(out).result?.value ?? out);
      process.exit(0);
    }
  }
  console.error(`no page on Metro :${port} holds the store; is the app running?`);
  process.exit(1);
} else {
  console.error("pass --web, --mobile [port] or --print");
  process.exit(2);
}
