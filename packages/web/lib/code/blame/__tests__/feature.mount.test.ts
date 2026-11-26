// Session blame as the editor core registers it, in a real EditorHost against
// a stubbed daemon: the toggle and its chip, one fetch per file version, the
// gutter staying aligned through typing, a save asking again, a folder that
// is not a repo, inline blame, and the frame budget on a 5,000-line file.
import { expect, mock, test } from "bun:test";
import { installEditorDom, settle } from "../../../../components/code/__tests__/editorDom";

installEditorDom();
localStorage.removeItem("codecast.code.blameGutter");

import type { CodeBlameHunk } from "@codecast/shared/contracts";

let repo = true;
let hunks: CodeBlameHunk[] = [];
const calls = { blame: 0, status: 0 };
let statusFails = false;
let blameFails: Error | null = null;

const realClient = { ...(await import("../../daemonClient")) };
mock.module("../../daemonClient", () => ({
  ...realClient,
  fetchGitStatus: async () => {
    calls.status++;
    if (statusFails) throw new TypeError("Failed to fetch");
    return { repo, branch: repo ? "main" : null, head: repo ? "h1" : null, ahead: 0, behind: 0, files: {} };
  },
  fetchGitBase: async (_ep: unknown, _v: string, path: string) => ({ path, ref: "HEAD", exists: true, content: "" }),
  fetchBlame: async (_ep: unknown, _v: string, path: string) => {
    calls.blame++;
    if (blameFails) throw blameFails;
    return { path, hunks };
  },
}));

const { useVaultStore } = await import("../../../../store/vaultStore");
const { EditorHost, openCodeBuffer } = await import("../../editorHost");
const { runCodeCommand } = await import("../../commands");
const { refreshGitStatus, useGitStatusStore } = await import("../../git/status");
const { setSavedDoc, codeBuffers, bufferKey } = await import("../../buffers");
const { setEditorSetting } = await import("../../editorSettings");
const { _clearBlameCache } = await import("../data");
const blame = await import("../gutter");
const { blameGutterOn } = await import("../index");

useVaultStore.setState({ activeVaultId: "v1", isRemote: false, endpoint: { url: "http://127.0.0.1:1", token: "t" } as any });
await refreshGitStatus("v1");

const parent = document.createElement("div");
document.body.append(parent);
const host = new EditorHost(parent, []);
const view = host.view;

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(blame.blameValue(view.state)?.status)} ${blame.blameValue(view.state)?.reason ?? ""}`);
};

const session = { id: "jx7aaaa", conversation_id: "a".repeat(32), title: "Fix the auth race", message_id: "m1" };
const runsView = () => blame.blameLineRuns(view.state).map((r) => [r.fromLine, r.toLine, r.kind]);
const chip = () => view.dom.querySelector<HTMLButtonElement>(".cm-blame-chip")!;
const labels = () => [...view.dom.querySelectorAll(".cm-blame-name")].map((e) => e.textContent);

test("blame.toggle shows the gutter, read once per file version", async () => {
  hunks = [
    { start: 1, end: 2, sha: "a".repeat(40), author: "Ada", summary: "first", time: Date.now() - 3 * 3_600_000, session },
    { start: 3, end: 3, sha: "b".repeat(40), author: "Lin", summary: "second", time: Date.now() - 86_400_000 },
  ];
  const buffer = openCodeBuffer({ vaultId: "v1", path: "src/a.ts", content: "one\ntwo\nthree\n", etag: "e1", readOnly: false });
  host.show(buffer);
  await until(() => !!view.dom.querySelector(".cm-blame-chip"), "the chip");
  expect(chip().disabled).toBe(false);
  expect(chip().hasAttribute("data-on")).toBe(false);
  expect(blame.blameValue(view.state)).toBeNull();

  expect(runCodeCommand("blame.toggle", undefined, { view, source: "vim" })).toBe(true);
  expect(blameGutterOn()).toBe(true);
  await until(() => blame.blameValue(view.state)?.status === "ready", "the blame");
  expect(runsView()).toEqual([
    [1, 2, "session"],
    [3, 3, "commit"],
  ]);
  expect(chip().hasAttribute("data-on")).toBe(true);
  expect(view.dom.querySelector(".cm-blame-gutter")).not.toBeNull();
  expect(labels()).toEqual(["Fix the auth race", "Lin"]);
  expect([...view.dom.querySelectorAll(".cm-blame-age")].map((e) => e.textContent)).toEqual(["3h", "1d"]);
  expect(calls.blame).toBe(1);

  // Another file and back: the field rides in the buffer's state, no fetch.
  const other = openCodeBuffer({ vaultId: "v1", path: "src/b.ts", content: "x\n", etag: "e9", readOnly: false });
  host.show(other);
  await until(() => blame.blameValue(view.state)?.status === "ready", "the other file");
  host.show(buffer);
  await settle();
  expect(runsView()).toEqual([
    [1, 2, "session"],
    [3, 3, "commit"],
  ]);
  expect(calls.blame).toBe(2);
});

test("typing keeps the gutter aligned, writes no store and fetches nothing", async () => {
  let writes = 0;
  const offs = [useVaultStore, useGitStatusStore].map((st) => (st as any).subscribe(() => writes++));
  const before = calls.blame;
  // o on line 1: a new line between the session's two lines.
  view.dispatch({ changes: { from: view.state.doc.line(1).to, insert: "\nnew" }, userEvent: "input.type" });
  for (let i = 0; i < 5; i++) view.dispatch({ changes: { from: view.state.doc.line(2).to, insert: "y" }, userEvent: "input.type" });
  offs.forEach((off: () => void) => off());
  expect(writes).toBe(0);
  expect(calls.blame).toBe(before);
  // Before the labels settle the new line already reads as uncommitted.
  const lineEls = [...view.dom.querySelectorAll(".cm-blame-gutter .cm-gutterElement .cm-blame-cell")].map((e) => (e as HTMLElement).dataset.kind);
  expect(lineEls).toEqual(["session", "edited", "session", "commit"]);
  await until(() => blame.blameValue(view.state)?.stale === false, "the labels to settle");
  expect(runsView()).toEqual([
    [1, 1, "session"],
    [2, 2, "edited"],
    [3, 3, "session"],
    [4, 4, "commit"],
  ]);
  expect(labels()).toEqual(["Fix the auth race", "Uncommitted", "Fix the auth race", "Lin"]);
});

test("a save asks again, and an edited buffer's unsaved lines start uncommitted", async () => {
  const buffer = codeBuffers.get(bufferKey("v1", "src/a.ts"))!;
  const before = calls.blame;
  hunks = [
    { start: 1, end: 1, sha: "a".repeat(40), author: "Ada", time: Date.now(), session },
    { start: 2, end: 4, uncommitted: true, time: Date.now() },
  ];
  buffer.baseEtag = "e2";
  view.dispatch({ effects: setSavedDoc.of(view.state.doc) });
  // Typing before the answer lands: placed against what was saved, then diffed.
  view.dispatch({ changes: { from: 0, insert: "zero\n" } });
  // The old blame stays drawn while the new version loads.
  expect(blame.blameValue(view.state)?.status).toBe("ready");
  await until(() => calls.blame > before && blame.blameValue(view.state)?.hunks === hunks, "the refetch");
  await until(() => blame.blameValue(view.state)?.stale === false, "settled");
  expect(runsView()).toEqual([
    [1, 1, "edited"],
    [2, 2, "session"],
    [3, 5, "uncommitted"],
  ]);
});

test("inline blame follows the cursor without React", async () => {
  setEditorSetting("inlineBlame", true);
  await until(() => !!view.dom.querySelector(".cm-blame-inline") || view.state.selection.main.head > 0, "inline on");
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
  await until(() => view.dom.querySelector(".cm-blame-inline")?.textContent === "Fix the auth race, just now", "inline text");
  view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
  expect(view.dom.querySelector(".cm-blame-inline")?.textContent).toBe("Uncommitted");
  setEditorSetting("inlineBlame", false);
  await until(() => !view.dom.querySelector(".cm-blame-inline"), "inline off");
});

test("a 5,000-line file draws its gutter inside a frame once the data lands", async () => {
  const n = 5000;
  const text = Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(i % 40)}`).join("\n") + "\n";
  const many: CodeBlameHunk[] = [];
  for (let start = 1; start <= n; start += 7) {
    many.push({
      start,
      end: Math.min(n, start + 6),
      sha: String(start).padStart(40, "0"),
      author: `A${start % 13}`,
      time: Date.now() - start * 60_000,
      ...(start % 3 === 0 ? { session: { id: `jx7${start}`, conversation_id: `c${start % 9}`, title: `Session ${start % 9}` } } : {}),
    });
  }
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { placeHunks, sessionHues } = await import("../model");
  const doc = EditorState.create({ doc: text }).doc;
  const samples: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t = performance.now();
    const value = blame.deriveBlame(
      { status: "ready", key: "k", hunks: many, placed: placeHunks(many, doc), edits: [], runs: [], hues: sessionHues(many), markers: undefined as never, stale: true, derivedAt: 0 },
      doc,
    );
    samples.push(performance.now() - t);
    expect(value.runs.length).toBe(many.length);
    expect(value.markers.size).toBe(n);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`blame derive, 5000 lines / ${many.length} hunks: median ${median.toFixed(2)} ms, max ${samples[samples.length - 1].toFixed(2)} ms`);
  expect(median).toBeLessThan(16);

  // The whole landing as the editor runs it: the effect through the field,
  // the gutter's DOM for the viewport, and a forced measure.
  const box = document.createElement("div");
  document.body.append(box);
  const landing: number[] = [];
  for (let i = 0; i < 15; i++) {
    const v = new EditorView({ state: EditorState.create({ doc: text, extensions: blame.blameExtension({ gutter: true, inline: false }) }), parent: box });
    const placed = placeHunks(many, v.state.doc);
    const t = performance.now();
    v.dispatch({ effects: blame.blameDataEffect.of({ key: "k", hunks: many, placed, edits: [] }) });
    (v as unknown as { measure(): void }).measure();
    landing.push(performance.now() - t);
    expect(v.dom.querySelectorAll(".cm-blame-cell").length).toBeGreaterThan(0);
    v.destroy();
  }
  box.remove();
  landing.sort((a, b) => a - b);
  const landMedian = landing[Math.floor(landing.length / 2)];
  console.log(`blame landing (field + gutter DOM + measure): median ${landMedian.toFixed(2)} ms, max ${landing[landing.length - 1].toFixed(2)} ms`);
  expect(landMedian).toBeLessThan(16);
});

test("a daemon that does not answer is asked on a backing-off clock, never in a loop", async () => {
  // Status not held, endpoint set, every status read failing.
  statusFails = true;
  useGitStatusStore.setState({ byVault: {} });
  const buffer = openCodeBuffer({ vaultId: "v1", path: "src/c.ts", content: "c\n", etag: "e3", readOnly: false });
  host.show(buffer);
  const before = calls.status;
  await until(() => blame.blameValue(view.state)?.status === "unavailable", "the soft failure");
  for (let i = 0; i < 30; i++) await settle();
  expect(calls.status - before).toBeLessThanOrEqual(2);
  expect(blame.blameValue(view.state)?.transient).toBe(true);
  expect(chip().disabled).toBe(false);
  expect(chip().dataset.state).toBe("retry");
  expect(chip().title).toBe("Session blame: Files are not connected, retrying. Click to hide");
  // The daemon comes back: the status arriving kicks the fetch.
  statusFails = false;
  await refreshGitStatus("v1");
  await until(() => blame.blameValue(view.state)?.status === "ready", "recovery");
  expect(chip().dataset.state).toBeUndefined();
});

test("a refetch that times out keeps the drawn gutter and the toggle", async () => {
  const drawn = blame.blameValue(view.state)!.runs;
  expect(drawn.length).toBeGreaterThan(0);
  blameFails = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const buffer = codeBuffers.get(bufferKey("v1", "src/c.ts"))!;
  buffer.baseEtag = "e4";
  view.dispatch({ changes: { from: view.state.doc.length, insert: "d\n" } });
  view.dispatch({ effects: setSavedDoc.of(view.state.doc) });
  await until(() => blame.blameValue(view.state)?.stale === false, "settled");
  const drawnNow = blame.blameValue(view.state)!.runs;
  await until(() => !!blame.blameValue(view.state)?.retry, "the retry mark");
  expect(blame.blameValue(view.state)?.status).toBe("ready");
  expect(blame.blameValue(view.state)?.runs).toEqual(drawnNow);
  expect(chip().disabled).toBe(false);
  expect(chip().title).toBe("Session blame: Blame timed out, retrying. Click to hide");
  blameFails = null;
});

test("a folder that is not a repo disables the toggle with the reason", async () => {
  repo = false;
  _clearBlameCache();
  await refreshGitStatus("v1");
  await until(() => blame.blameValue(view.state)?.status === "unavailable", "the field");
  expect(view.dom.querySelectorAll(".cm-blame-cell").length).toBe(0);
  // On, it can still be turned off here; off, it cannot be turned on here.
  expect(blameGutterOn()).toBe(true);
  expect(chip().disabled).toBe(false);
  expect(chip().title).toBe("Session blame: Not a git repository. Click to hide");
  expect(runCodeCommand("blame.toggle", undefined, { view, source: "vim" })).toBe(true);
  expect(blameGutterOn()).toBe(false);
  await until(() => chip().disabled, "the chip to disable");
  expect(chip().title).toBe("Session blame: Not a git repository");
  expect(chip().hasAttribute("data-on")).toBe(false);
  expect(runCodeCommand("blame.toggle", undefined, { view, source: "vim" })).toBe(true);
  expect(blameGutterOn()).toBe(false);
});

test("files disconnected: disabled, never an error dump", async () => {
  repo = true;
  useVaultStore.setState({ endpoint: null as any });
  await until(() => chip().title === "Session blame: Files are not connected", "the reason");
  expect(chip().disabled).toBe(true);
  host.destroy();
});
