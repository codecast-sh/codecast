// Builder quality eval: real requests through the dev deployment, the way
// people make them. Each scenario makes an app from a prompt and then asks
// for follow-up changes (concrete, vague, and pointed at an element). Every
// version that goes live is fetched as served, mounted and used in happy-dom
// (scripts/lib/mount.ts), and graded by a judge model on whether it did what
// was asked, whether it is multiplayer where it should be, and how it looks.
//
//   bun scripts/builder-evals.ts <label> [scenario...]
//   bun scripts/builder-evals.ts <label> --first [scenario...]   new apps only
//
// Writes /tmp/pg-evals/<label>/results.json and prints one row per build,
// for packages/playground/notes/builder-evals.md.
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAssistant } from "@platform/agent";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ROOT, timeBuild, visitor, type BuildTiming, type Visitor } from "./lib/harness";
import { fetchServed, mount, stage, type MountReport } from "./lib/served";

const BUILD_TIMEOUT_MS = 300_000;
const JUDGE_MODEL = "claude-opus-5-5";

type Step = { ask: string; pick?: { tag?: string; text?: string } };
type Scenario = { key: string; multiplayer: boolean; steps: Step[] };

const SCENARIOS: Scenario[] = [
  {
    key: "drawing",
    multiplayer: true,
    steps: [
      { ask: "A multiplayer drawing wall: everyone draws on one big shared canvas with their own color, and you can see who drew what." },
      { ask: "make it more fun" },
      { ask: "make this bigger and put an eraser next to it", pick: { tag: "button" } },
      { ask: "let me undo my last stroke" },
    ],
  },
  {
    key: "poll",
    multiplayer: true,
    steps: [
      { ask: "A voting poll for where the team should go for lunch. Anyone can add an option and everyone gets one vote." },
      { ask: "show the results as bars that animate when votes come in" },
      { ask: "change this to ask about Friday's team dinner instead", pick: { tag: "h1" } },
      { ask: "make it more fun" },
    ],
  },
  {
    key: "platformer",
    multiplayer: true,
    steps: [
      { ask: "A tiny platformer: a frog hops across platforms collecting flies, with a shared high score board." },
      { ask: "add a double jump" },
      { ask: "make it more fun" },
      { ask: "make this bigger and put a little trophy next to it", pick: { text: "score" } },
    ],
  },
  {
    key: "todo",
    multiplayer: true,
    steps: [
      { ask: "A shared todo list for our flat: chores, who claimed each one, and tick them off when done." },
      { ask: "let people drag chores to reorder them" },
      { ask: "let me pick a due day right here when I add a chore", pick: { tag: "input" } },
      { ask: "dark mode please" },
    ],
  },
  {
    key: "guestbook",
    multiplayer: true,
    steps: [
      { ask: "A guestbook for my birthday party where people leave a note and pick a sticker." },
      { ask: "make it look like a cork board with pinned paper notes" },
      { ask: "make it more fun" },
      { ask: "make this say 'Pin it' and give it a little wiggle", pick: { tag: "button" } },
    ],
  },
  {
    key: "pixels",
    multiplayer: true,
    steps: [
      { ask: "A collaborative 32x32 pixel art canvas with a palette of 16 colors." },
      { ask: "add a timelapse that replays how the picture was made" },
      { ask: "add a few pastel colors here", pick: { tag: "button", text: "color" } },
      { ask: "make it more fun" },
    ],
  },
  {
    key: "emoji",
    multiplayer: true,
    steps: [
      { ask: "Chat roulette of emoji: you get paired with a random person in the room and can only talk in emoji." },
      { ask: "add sound effects" },
      { ask: "make it more fun" },
      { ask: "this is confusing, make it clearer what to do", pick: { tag: "p" } },
    ],
  },
  {
    key: "kanban",
    multiplayer: true,
    steps: [
      { ask: "A kanban board for our hackathon team with todo, doing and done columns." },
      { ask: "limit doing to 3 cards and show a warning when it's full" },
      { ask: "give this column its own color", pick: { tag: "h2" } },
      { ask: "make it feel calmer" },
    ],
  },
  {
    key: "guessing",
    multiplayer: true,
    steps: [
      { ask: "Drawing guessing game: one person draws a secret word, everyone else guesses in chat, points for fast guesses." },
      { ask: "show a clear way to invite friends" },
      { ask: "make it more fun" },
    ],
  },
  {
    key: "standup",
    multiplayer: true,
    steps: [
      { ask: "Async standup for our team: each person posts yesterday, today and blockers once a day, and we see the week at a glance." },
      { ask: "show what keeps coming up in blockers" },
    ],
  },
  {
    key: "groceries",
    multiplayer: true,
    steps: [
      { ask: "Shared grocery list for our flat, grouped by aisle, tick things off as you shop." },
      { ask: "add a button to clear everything that's done" },
    ],
  },
  {
    key: "drums",
    multiplayer: true,
    steps: [
      { ask: "16-step drum machine everyone plays together: kick, snare, hats and clap, one shared pattern." },
      { ask: "let people save patterns and load them back" },
    ],
  },
  {
    key: "weather",
    multiplayer: true,
    steps: [
      { ask: "A weather board for the cities our team lives in, anyone can add a city." },
      { ask: "make it feel calmer" },
    ],
  },
];

type Row = {
  scenario: string;
  step: number;
  buildId: string | null;
  ask: string;
  element: string | null;
  status: string;
  version: number | null;
  totalMs: number;
  buildMs: number | null;
  costUsd: number | null;
  summary: string | null;
  error: string | null;
  mount: MountReport | null;
  usesSdk: string[];
  judge: Judgement | null;
  /** What the checks found wrong, beyond the judge's view. */
  defects: string[];
  dir: string | null;
};

type Judgement = { did_it: number; multiplayer: number | null; look: number; notes: string };

const EVALS = "/tmp/pg-evals";

/** A gesture that writes more than this is writing on every move. */
const GESTURE_WRITES_MAX = 6;
/** Text only the seed template has; finding it in a built app means the starter leaked. */
const SEED_MARKS = [/Wave hello/, /"waves"/, /This app is new/];
/** The starter's colors; an app that still has all of them never got a look of its own. */
const SEED_PALETTE = ["#2b2520", "#f7f3ec", "#c4491f"];

/** The toy look the founder rejected, read from the source: a web-safe or
 *  rounded novelty face, no web font at all, and surfaces drawn as outlined
 *  stickers with hard offset shadows. */
const NOVELTY_FACES = /Trebuchet|Comic Sans|Fredoka|Baloo|Nunito|Chewy|Bubblegum|Luckiest|Varela Round|Quicksand|Patrick Hand|Sniglet|Gochi/i;
/** A box-shadow with an offset and no blur: "0 4px 0 var(--ink)", "3px 3px 0 #000". */
const HARD_SHADOW = /box-shadow:\s*(?:inset\s+)?-?\d+(?:\.\d+)?(?:px)?\s+-?\d+(?:\.\d+)?(?:px)?\s+0(?:px)?\s+(?![-\d])/g;
const THICK_OUTLINE = /border(?:-(?:top|bottom|left|right))?:\s*(?:[2-9]|\d{2})px\s+solid/g;
const LOOK_LIMITS = { hardShadows: 3, thickOutlines: 5 };

export function lookDefects(code: string): string[] {
  const out: string[] = [];
  const face = NOVELTY_FACES.exec(code)?.[0];
  if (face) out.push(`novelty face: ${face}`);
  if (!/fonts\.googleapis\.com|@font-face/.test(code)) out.push("loads no web font");
  const shadows = code.match(HARD_SHADOW)?.length ?? 0;
  if (shadows >= LOOK_LIMITS.hardShadows) out.push(`hard offset shadows on ${shadows} rules`);
  const outlines = code.match(THICK_OUTLINE)?.length ?? 0;
  if (outlines >= LOOK_LIMITS.thickOutlines) out.push(`thick outlines on ${outlines} rules`);
  return out;
}

function defectsOf(m: MountReport | null, code: string): string[] {
  const out: string[] = [];
  if (!m) return ["not served"];
  if (!m.firstPaint.painted) out.push("renders nothing");
  if (m.errors.length) out.push(`throws: ${m.errors[0]}`);
  if (m.sdk.refused.length) out.push(`backend would refuse: ${m.sdk.refused[0]}`);
  const storm = m.steps.find((s) => s.writes > GESTURE_WRITES_MAX);
  if (storm) out.push(`writes on every move: ${storm.writes} writes for one ${storm.what}`);
  if (SEED_PALETTE.every((c) => code.includes(c))) out.push("kept the starter's palette");
  const leaked = SEED_MARKS.filter((re) => re.test(code));
  if (leaked.length) out.push(`starter leftovers: ${leaked.map(String).join(" ")}`);
  if (code.includes("\u2014")) out.push("emdash in the app's text");
  return [...out, ...lookDefects(code)];
}

// ---- Summary ---------------------------------------------------------------------

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** A hit: live, runs clean, no defects, and the judge says it did what was asked without losing multiplayer. */
const isHit = (r: Row) => r.status === "live" && !!r.mount?.ok && !r.defects.length && r.judge?.did_it === 2 && r.judge.multiplayer !== 0 && r.judge.look >= 1;

function summarize(label: string, rows: Row[]): string {
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const first = rows.filter((r) => r.step === 0).map((r) => r.totalMs);
  const changes = rows.filter((r) => r.step > 0).map((r) => r.totalMs);
  const costs = rows.map((r) => r.costUsd).filter((c): c is number => c !== null);
  return [
    `${label}: ${rows.filter(isHit).length}/${rows.length} hits`,
    `live ${rows.filter((r) => r.status === "live").length}`,
    `defects ${rows.filter((r) => r.defects.length).length}`,
    `top look ${rows.filter((r) => isHit(r) && r.judge!.look === 2).length}`,
    `median ${secs(median(rows.map((r) => r.totalMs)))} (new app ${secs(median(first))}, max ${secs(Math.max(...first))}; change ${secs(median(changes))})`,
    `median $${median(costs).toFixed(3)}, total $${costs.reduce((a, b) => a + b, 0).toFixed(2)}`,
  ].join(" | ");
}

async function diff(a: string, b: string): Promise<string> {
  const proc = Bun.spawn(["git", "diff", "--no-index", "--no-color", "-U2", a, b], { stdout: "pipe" });
  return (await new Response(proc.stdout).text()).replaceAll(a, "a").replaceAll(b, "b");
}

const JUDGE_SYSTEM = `\
You grade one change made by an AI builder to a small multiplayer web app.
People in a shared room ask for changes in plain words; the builder edits the
app's files and the change goes live for everyone. The app runs with a
"playground" SDK: useCollection and useShared are live shared data for
everyone, usePresence is who is here now, me is the current person.

You get the request, the element it pointed at (if any), the builder's
summary, the diff of the source (or the full source for a new app), and what
happened when the app was mounted headlessly and used (errors, whether using
it wrote shared data).

Grade strictly, as a demanding product designer who will show this to people:
- did_it: 2 = fully does what was asked, in the spirit it was asked (a vague
  request like "make it more fun" gets a real, felt improvement to what people
  do in the app, not a pile of effects); 1 = partly, or does it but breaks or
  drops something else; 0 = not done or broken.
- multiplayer: 2 = things people make or score are shared live through the
  SDK and people can see each other; 1 = shared but thin (no faces, no sense
  of others); 0 = local only where sharing was clearly wanted; null if the
  request is unrelated to sharing and nothing regressed.
- look: 2 = reads as real, well-made software: its purpose and controls are
  clear at a glance, typography is chosen (a well-made web font that suits
  the subject, a clear scale, considered spacing), one coherent visual idea
  fits the subject, borders, shadows and strong fills only where they carry
  structure or state, playful touches are small and serve the use, works on
  a phone; 1 = fine but generic or rough, or trying too hard (a web-safe or
  rounded novelty face, every surface outlined with hard offset shadows,
  sticker styling, decoration or gimmicks that crowd the actual use); 0 =
  ugly or broken layout. A first screen that is empty for one person alone
  is a weaker look than one that shows the app working.

Answer with only a JSON object: {"did_it":n,"multiplayer":n|null,"look":n,"notes":"one or two sentences"}`;

async function judge(input: string): Promise<Judgement | null> {
  const result = await runAssistant({
    model: JUDGE_MODEL,
    system: JUDGE_SYSTEM,
    history: [{ role: "user", content: input }],
    ceilingUsd: 0.5,
    deadlineMs: 120_000,
    apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY ?? (await anthropicKey()) },
  });
  const text = result.messages.map((m) => (m.role === "assistant" ? (m.content ?? "") : "")).join("");
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  try {
    return json ? (JSON.parse(json) as Judgement) : null;
  } catch {
    return null;
  }
}

async function anthropicKey(): Promise<string> {
  const proc = Bun.spawn(["npx", "convex", "env", "get", "ANTHROPIC_API_KEY"], { cwd: ROOT, stdout: "pipe" });
  return (await new Response(proc.stdout).text()).trim();
}

function mountLine(m: MountReport | null): string {
  if (!m) return "not mounted";
  const writes = m.sdk.insert + m.sdk.update + m.sdk.remove + m.sdk.setShared;
  return [
    m.firstPaint.painted ? "rendered" : "rendered NOTHING",
    m.errors.length ? `errors: ${m.errors.join(" | ")}` : "no errors",
    `using it wrote ${writes} shared changes and ${m.sdk.setMyState} presence updates`,
    m.sdk.refused.length ? `the backend would refuse: ${m.sdk.refused.join(" | ")}` : "",
    `steps: ${m.steps.map((s) => `${s.what} (${s.writes} writes)`).join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Grade one live row from what is on disk: the request, the source as it
 *  became (in full for a new app, else the diff from the version before). */
async function judgeRow(r: Row, prev: number): Promise<Judgement | null> {
  const app = join(r.dir!, "..");
  const after = join(app, `src-v${r.version}`);
  const changes =
    r.step === 0
      ? (await Array.fromAsync(new Bun.Glob("**/*").scan(after))).sort().map((f) => `## ${f}\n${readFileSync(join(after, f), "utf8")}`).join("\n\n")
      : (await diff(join(app, `src-v${prev}`), after)).slice(0, 60_000);
  return judge(
    [
      `# Request\n${r.ask}`,
      r.element ? `# Pointed at\n${r.element}` : "",
      `# Builder's summary\n${r.summary}`,
      `# Mounted and used\n${mountLine(r.mount)}${r.defects.length ? `\nChecks found: ${r.defects.join("; ")}` : ""}`,
      r.step === 0 ? `# The new app's source\n${changes}` : `# Diff of the source\n${changes}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  ).catch(() => null);
}


// Mount every live version of a finished run again and recheck it, for when
// the checks change; the judge's grades stay.
if (process.argv[2] === "--rescore") {
  const file = join(EVALS, process.argv[3], "results.json");
  const result = (await Bun.file(file).json()) as { rows: Row[] };
  for (const r of result.rows) {
    if (!r.dir || r.version === null) continue;
    const job = await Bun.file(join(r.dir, "job.json")).json();
    r.mount = await mount(r.dir, { html: job.html, entries: job.entries });
    const src = join(r.dir, "..", `src-v${r.version}`);
    const glob = new Bun.Glob("**/*");
    let code = "";
    for await (const f of glob.scan(src)) code += (await Bun.file(join(src, f)).text()) + "\n";
    r.defects = defectsOf(r.mount, code);
  }
  await Bun.write(file, JSON.stringify(result, null, 2));
  process.argv.splice(2, 2, "--stats", process.argv[3]);
}

// Grade a finished run again with the current judge, so runs graded by an
// older rubric compare like for like.
if (process.argv[2] === "--rejudge") {
  const file = join(EVALS, process.argv[3], "results.json");
  const result = (await Bun.file(file).json()) as { rows: Row[] };
  const prevOf = (r: Row) => result.rows.filter((x) => x.scenario === r.scenario && x.step < r.step && x.version !== null).at(-1)?.version ?? 1;
  await Promise.all(result.rows.filter((r) => r.dir && r.version !== null).map(async (r) => (r.judge = await judgeRow(r, prevOf(r)))));
  await Bun.write(file, JSON.stringify(result, null, 2));
  process.argv.splice(2, 2, "--stats", process.argv[3]);
}

if (process.argv[2] === "--stats") {
  for (const label of process.argv.slice(3)) {
    const { rows } = (await Bun.file(join(EVALS, label, "results.json")).json()) as { rows: Row[] };
    console.log(summarize(label, rows));
    for (const r of rows.filter((r) => !isHit(r))) console.log(`   miss ${r.scenario}#${r.step}: ${[...r.defects, r.error, r.judge && `judge ${r.judge.did_it}/${r.judge.multiplayer}/${r.judge.look}: ${r.judge.notes}`].filter(Boolean).join("; ").slice(0, 300)}`);
  }
  process.exit(0);
}

const label = process.argv[2] ?? `run-${Date.now()}`;
const firstOnly = process.argv.includes("--first");
const only = process.argv.slice(3).filter((a) => a !== "--first");
const OUT = join(EVALS, label);
await mkdir(OUT, { recursive: true });

const SDK_HOOKS = ["useCollection", "useShared", "usePresence", "me"];

async function sourceFiles(v: Visitor, appId: Id<"apps">, n: number) {
  const res = await v.client.query(api.versions.files, { ...v.creds, app_id: appId, number: n });
  return (res?.files ?? []).map((f) => ({ path: f.path, text: f.text ?? "" }));
}

async function writeTree(dir: string, files: { path: string; text: string }[]) {
  for (const f of files) await Bun.write(join(dir, f.path), f.text);
}

async function runScenario(s: Scenario): Promise<Row[]> {
  const v = await visitor();
  const rows: Row[] = [];
  let appId: Id<"apps"> | null = null;
  let slug = "";
  let live = 1;
  let room: ReturnType<Visitor["watchRoom"]> | null = null;

  for (const [i, step] of s.steps.entries()) {
    let element: MountReport["picked"] = null;
    if (step.pick && appId) {
      const dir = join(OUT, slug, `pick-v${live}`);
      element = (await mount(dir, await stage(await fetchServed(slug, live), dir), step.pick)).picked;
    }
    const sent = performance.now();
    let messageId: string;
    if (!appId) {
      const app = await v.client.mutation(api.apps.create, { ...v.creds, prompt: step.ask });
      appId = app.app_id as Id<"apps">;
      slug = app.slug;
      room = v.watchRoom(appId);
      messageId = app.request_message_id!;
    } else {
      const sentMsg = await v.client.mutation(api.messages.send, { ...v.creds, app_id: appId, mode: "change", body: step.ask, ...(element ? { element } : {}) });
      messageId = sentMsg.message_id;
    }
    let timing: BuildTiming | null = null;
    try {
      timing = await timeBuild(room!, `${s.key}#${i}`, messageId, sent, BUILD_TIMEOUT_MS);
    } catch (e) {
      console.log(`${s.key}#${i} timed out: ${e}`);
    }
    const b = timing?.build;
    const row: Row = {
      scenario: s.key,
      step: i,
      buildId: b?.id ?? null,
      ask: step.ask,
      element: element ? `${element.tag}: ${element.text ?? ""}` : step.pick ? "(pick found nothing)" : null,
      status: b?.status ?? "timeout",
      version: b?.result_version ?? null,
      totalMs: timing ? Math.round(timing.total) : BUILD_TIMEOUT_MS,
      buildMs: b?.started_at && b.finished_at ? b.finished_at - b.started_at : null,
      costUsd: null,
      summary: b?.summary ?? null,
      error: b?.error ? `${b.error}: ${b.error_detail ?? ""}`.slice(0, 400) : null,
      mount: null,
      usesSdk: [],
      judge: null,
      defects: b?.status === "live" ? [] : [`build ${b?.status ?? "timed out"}`],
      dir: null,
    };
    if (b?.status === "live" && b.result_version) {
      const n = b.result_version;
      const dir = join(OUT, slug, `v${n}`);
      row.dir = dir;
      const before = await sourceFiles(v, appId, live);
      const after = await sourceFiles(v, appId, n);
      await writeTree(join(OUT, slug, `src-v${live}`), before);
      await writeTree(join(OUT, slug, `src-v${n}`), after);
      try {
        row.mount = await mount(dir, await stage(await fetchServed(slug, n), dir));
      } catch (e) {
        row.mount = null;
        row.error = `serve: ${e}`;
      }
      const code = after.filter((f) => /\.(jsx?|tsx?)$/.test(f.path)).map((f) => f.text).join("\n");
      row.usesSdk = SDK_HOOKS.filter((h) => new RegExp(`\\b${h}\\b`).test(code) && /from\s+["']playground["']/.test(code));
      row.defects = defectsOf(row.mount, after.map((f) => f.text).join("\n"));
      if (row.summary?.includes("\u2014")) row.defects.push("emdash in the summary");
      row.judge = await judgeRow(row, live);
      live = n;
    }
    rows.push(row);
    console.log(`${s.key}#${i} ${row.status} v${row.version ?? "-"} ${(row.totalMs / 1000).toFixed(1)}s ${row.mount?.ok ? "runs" : "BROKEN"} judge=${JSON.stringify(row.judge)}`);
  }
  room?.stop();
  await v.client.close();
  return rows;
}

const chosen = SCENARIOS.filter((s) => !only.length || only.includes(s.key)).map((s) => (firstOnly ? { ...s, steps: s.steps.slice(0, 1) } : s));
const rows = (await Promise.all(chosen.map((s) => runScenario(s).catch((e) => (console.log(`${s.key} crashed: ${e}`), [] as Row[]))))).flat();

// Costs live on the build rows; read them from the deployment.
const dump = Bun.spawn(["npx", "convex", "data", "builds", "--limit", "2000", "--format", "jsonl"], { cwd: ROOT, stdout: "pipe" });
const builds = (await new Response(dump.stdout).text())
  .split("\n")
  .filter((l) => l.startsWith("{"))
  .map((l) => JSON.parse(l) as { _id: string; cost_usd?: number });
const cost = new Map(builds.map((b) => [b._id, b.cost_usd ?? null]));
for (const row of rows) row.costUsd = row.buildId ? (cost.get(row.buildId) ?? null) : null;

await Bun.write(join(OUT, "results.json"), JSON.stringify({ label, rows, builds: builds.length }, null, 2));
console.log(`\n${summarize(label, rows)}\nwrote ${join(OUT, "results.json")}`);
