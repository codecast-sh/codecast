// The project search controller against a real HTTP stream: NDJSON split
// anywhere, results visible before the search ends, every new query aborting
// the last, and F4 walking the matches across files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CodeSearchEvent } from "@codecast/shared/contracts";
import { useVaultStore } from "../../../../store/vaultStore";
import { registerCodeCommand } from "../../commands";
import { projectSearch, registerProjectSearchCommands } from "../controller";
import { SearchResults } from "../model";

const fileEvent = (path: string, lines: [number, string, [number, number][]][]): CodeSearchEvent => ({
  type: "file",
  path,
  lines: lines.map(([line, text, ranges]) => ({ line, text, ranges: ranges.map(([start, end]) => ({ start, end })) })),
});

const EVENTS: CodeSearchEvent[] = [
  fileEvent("src/a.ts", [
    [3, "const needle = needle; // é", [[6, 12], [15, 21]]],
    [9, "needle()", [[0, 6]]],
  ]),
  fileEvent("src/b.ts", [[1, "  needle", [[2, 8]]]]),
  { type: "done", files: 2, matches: 4, truncated: true, elapsed_ms: 7, engine: "rg" },
];

let server: ReturnType<typeof Bun.serve>;
const requests: string[] = [];
/** Per request: whether it asked for a regex search. */
const regexFlags: boolean[] = [];
const cancelled: string[] = [];
/** Per query: resolves to let the stream finish. */
const gates = new Map<string, () => void>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const q = new URL(req.url).searchParams.get("q") ?? "";
      requests.push(q);
      regexFlags.push(new URL(req.url).searchParams.get("regex") === "1" || new URL(req.url).searchParams.get("regex") === "true");
      if (q === "bad(") return new Response(JSON.stringify({ type: "error", message: "regex parse error: unclosed group" }) + "\n");
      if (q === "nothing") return new Response(JSON.stringify({ type: "done", files: 0, matches: 0, truncated: false, elapsed_ms: 1, engine: "rg" }) + "\n");
      const bytes = new TextEncoder().encode(EVENTS.map((e) => JSON.stringify(e) + "\n").join(""));
      const firstFileEnd = bytes.indexOf(10) + 1;
      return new Response(
        new ReadableStream({
          async start(controller) {
            // The first file in two pieces split mid-line, then a pause, then the rest 5 bytes at a time.
            controller.enqueue(bytes.slice(0, 20));
            controller.enqueue(bytes.slice(20, firstFileEnd));
            await new Promise<void>((resolve) => gates.set(q, resolve));
            for (let at = firstFileEnd; at < bytes.length; at += 5) controller.enqueue(bytes.slice(at, at + 5));
            controller.close();
          },
          cancel() {
            cancelled.push(q);
          },
        }),
      );
    },
  });
  useVaultStore.setState({ endpoint: { port: server.port!, token: "t", deviceId: "d", tmux: false } as never, activeVaultId: "v1" });
});

afterAll(() => server.stop(true));

const until = async (cond: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("streaming", () => {
  test("the first file shows before the search ends; done brings counts and truncation", async () => {
    projectSearch.schedule("needle", { immediate: true });
    await until(() => (projectSearch.get().results?.files.length ?? 0) === 1);
    const r = projectSearch.get().results!;
    expect(projectSearch.get().running).toBe(true);
    expect(r.firstResultMs).not.toBeNull();
    expect(r.summary).toBeNull();
    gates.get("needle")!();
    await until(() => !projectSearch.get().running);
    expect(r.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.summary).toMatchObject({ matches: 4, truncated: true, engine: "rg" });
    expect(r.files[0].lines[0].text).toContain("é");
  });

  test("a new query aborts the one running, which never lands", async () => {
    projectSearch.schedule("first", { immediate: true });
    await until(() => gates.has("first"));
    const firstResults = projectSearch.get().results;
    projectSearch.schedule("second", { immediate: true });
    await until(() => cancelled.includes("first"));
    gates.get("first")!();
    await until(() => gates.has("second"));
    gates.get("second")!();
    await until(() => !projectSearch.get().running);
    expect(projectSearch.get().text).toBe("second");
    expect(projectSearch.get().results).not.toBe(firstResults);
  });

  test("typing within the debounce sends one request", async () => {
    const before = requests.length;
    projectSearch.schedule("n");
    projectSearch.schedule("ne");
    projectSearch.schedule("nee");
    await until(() => gates.has("nee"));
    gates.get("nee")!();
    await until(() => !projectSearch.get().running);
    expect(requests.slice(before)).toEqual(["nee"]);
  });

  test("a character typed and deleted inside the debounce searches what the box shows", async () => {
    // The pane's rule: search when the box differs from what was last asked.
    const box = (text: string) => {
      if (text !== projectSearch.wanted() || !projectSearch.get().results) projectSearch.schedule(text);
    };
    projectSearch.schedule("tok", { immediate: true });
    await until(() => gates.has("tok"));
    gates.get("tok")!();
    await until(() => !projectSearch.get().running);
    gates.delete("tok");
    const before = requests.length;
    box("tokx");
    box("tok");
    await until(() => gates.has("tok"));
    gates.get("tok")!();
    await until(() => !projectSearch.get().running);
    await new Promise((r) => setTimeout(r, 200));
    expect(requests.slice(before)).toEqual(["tok"]);
    expect(projectSearch.get().text).toBe("tok");
    expect(projectSearch.wanted()).toBe("tok");
  });

  test("results carry the vault they searched", async () => {
    gates.delete("needle");
    projectSearch.schedule("needle", { immediate: true });
    await until(() => gates.has("needle"));
    gates.get("needle")!();
    await until(() => !projectSearch.get().running);
    expect(projectSearch.get().results!.vaultId).toBe("v1");
    expect(projectSearch.current()).toBe(true);
  });

  test("the last results stay on screen until the new search's first event", async () => {
    gates.delete("needle");
    projectSearch.schedule("needle", { immediate: true });
    await until(() => gates.has("needle"));
    gates.get("needle")!();
    await until(() => !projectSearch.get().running);
    const old = projectSearch.get().results!;
    const kept = old.matches()[1].key;
    projectSearch.set({ active: kept });
    gates.delete("needle");
    // Same paths and lines, so the selection survives the swap.
    projectSearch.schedule("needle", { immediate: true });
    expect(projectSearch.get().running).toBe(true);
    expect(projectSearch.get().results).toBe(old);
    expect(projectSearch.get().stale).toBe(true);
    expect(projectSearch.get().active).toBe(kept);
    // The first file arrives before the gate opens: that is the swap.
    await until(() => projectSearch.get().results !== old);
    expect(projectSearch.get().stale).toBe(false);
    expect(projectSearch.get().results!.query).toMatchObject({ text: "needle" });
    gates.get("needle")!();
    await until(() => !projectSearch.get().running);
    expect(projectSearch.get().active).toBe(kept);
  });

  test("an empty answer replaces the last results when it is done, and drops a selection it lacks", async () => {
    const old = projectSearch.get().results!;
    projectSearch.set({ active: old.matches()[0].key });
    projectSearch.schedule("nothing", { immediate: true });
    expect(projectSearch.get().results).toBe(old);
    await until(() => !projectSearch.get().running);
    const r = projectSearch.get().results!;
    expect(r).not.toBe(old);
    expect(r.files).toEqual([]);
    expect(r.summary).toMatchObject({ matches: 0 });
    expect(projectSearch.get().stale).toBe(false);
    expect(projectSearch.get().active).toBeNull();
  });

  test("the daemon's error is the results' error", async () => {
    projectSearch.schedule("bad(", { immediate: true });
    await until(() => !projectSearch.get().running);
    expect(projectSearch.get().results!.error).toContain("unclosed group");
  });

  test("an empty query clears", () => {
    projectSearch.schedule("");
    expect(projectSearch.get().results).toBeNull();
  });
});

describe("the results model", () => {
  test("files sort by path whatever order they stream in", () => {
    const r = new SearchResults();
    for (const p of ["src/z.ts", "a.md", "src/b.ts", "src/a.ts", "lib/x.ts"]) r.add(fileEvent(p, [[1, "needle", [[0, 6]]]]));
    r.add(fileEvent("src/b.ts", [[4, "needle", [[0, 6]]]]));
    expect(r.files.map((f) => f.path)).toEqual(["a.md", "lib/x.ts", "src/a.ts", "src/b.ts", "src/z.ts"]);
    expect(r.file("src/b.ts")!.lines.map((l) => l.line)).toEqual([1, 4]);
  });

  const model = () => {
    const r = new SearchResults();
    for (const e of structuredClone(EVENTS)) r.add(e);
    return r;
  };

  test("rows: a header per file, a row per match", () => {
    const r = model();
    expect(r.rows().map((x) => (x.kind === "file" ? `# ${x.file.path} ${x.count}` : `${x.line.line}:${x.line.ranges[x.range].start}`))).toEqual([
      "# src/a.ts 3",
      "3:6",
      "3:15",
      "9:0",
      "# src/b.ts 1",
      "1:2",
    ]);
  });

  test("collapse hides rows but F4 still walks them; dismiss removes them", () => {
    const r = model();
    r.toggleCollapsed("src/a.ts");
    expect(r.rows().length).toBe(3);
    expect(r.matches().length).toBe(4);
    r.dismiss(r.matches()[0].key);
    expect(r.counts()).toEqual({ matches: 3, files: 2 });
    r.dismiss("src/b.ts");
    expect(r.counts()).toEqual({ matches: 2, files: 1 });
    expect([...r.targets().get("src/a.ts")!]).toEqual([
      { line: 3, column: 15 },
      { line: 9, column: 0 },
    ]);
  });

  test("a dismissed match stays dismissed after a replace moves its line", () => {
    const r = new SearchResults();
    r.add({ type: "file", path: "x.ts", lines: [{ line: 1, text: "foo foo", ranges: [{ start: 0, end: 3 }, { start: 4, end: 7 }] }] });
    r.add({ type: "file", path: "y.ts", lines: [{ line: 2, text: "foo", ranges: [{ start: 0, end: 3 }] }, { line: 4, text: "a foo", ranges: [{ start: 2, end: 5 }] }] });
    r.dismiss(r.matches().find((m) => m.file.path === "x.ts" && m.range === 1)!.key);
    r.replaced("x.ts", [{ line: 1, column: 0, length: 3, insert: "barbar" }]);
    expect(r.targets().get("x.ts")).toBeUndefined();
    expect(r.file("x.ts")).toBeUndefined();
    // A replacement that adds line breaks moves the lines below it; the
    // dismissed one below stays out.
    r.dismiss(r.matches().find((m) => m.file.path === "y.ts" && m.line.line === 4)!.key);
    r.replaced("y.ts", [{ line: 2, column: 0, length: 3, insert: "a\nb" }]);
    expect(r.targets().size).toBe(0);
    expect(r.counts()).toEqual({ matches: 0, files: 0 });
  });

  test("a trimmed long line's matches are at offset + start", () => {
    const r = new SearchResults();
    r.add({ type: "file", path: "min.js", lines: [{ line: 1, text: "xx needle", offset: 5000, ranges: [{ start: 3, end: 9 }] }] });
    expect(r.targets().get("min.js")).toEqual([{ line: 1, column: 5003 }]);
  });

  test("a replace removes its match and moves the rest of the line", () => {
    const r = model();
    r.replaced("src/a.ts", [{ line: 3, column: 6, length: 6, insert: "pin" }]);
    const line = r.file("src/a.ts")!.lines[0];
    expect(line.text).toBe("const pin = needle; // é");
    expect(line.ranges).toEqual([{ start: 12, end: 18 }]);
    r.replaced("src/b.ts", [{ line: 1, column: 2, length: 6, insert: "x" }]);
    expect(r.file("src/b.ts")).toBeUndefined();
  });
});

test("F4 and Shift-F4 walk matches across files, wrapping, through file.open", async () => {
  registerProjectSearchCommands();
  const r = new SearchResults("v1");
  for (const e of structuredClone(EVENTS)) r.add(e);
  // Load a finished result without the network.
  (projectSearch as unknown as { state: object }).state = { ...projectSearch.get(), results: r, active: null };
  const opened: unknown[] = [];
  const off = registerCodeCommand("file.open", (args) => void opened.push(args));
  const { runCodeCommand } = await import("../../commands");
  runCodeCommand("search.next");
  runCodeCommand("search.next");
  runCodeCommand("search.prev");
  runCodeCommand("search.prev");
  off();
  expect(opened).toEqual([
    { path: "src/a.ts", line: 3, column: 7 },
    { path: "src/a.ts", line: 3, column: 16 },
    { path: "src/a.ts", line: 3, column: 7 },
    { path: "src/b.ts", line: 1, column: 3 },
  ]);
});

test("search.project fills the query and opens the Search tab", async () => {
  registerProjectSearchCommands();
  const { runCodeCommand } = await import("../../commands");
  runCodeCommand("search.project", { query: "TODO", regex: true });
  expect(useVaultStore.getState().searchQuery).toBe("TODO");
  expect(useVaultStore.getState().leftPaneTab).toBe("search");
  expect(projectSearch.get().options.regex).toBe(true);
  projectSearch.set({ options: { regex: false } });
});

test("F4 does nothing with results from another vault", async () => {
  registerProjectSearchCommands();
  const r = new SearchResults("another-worktree");
  for (const e of structuredClone(EVENTS)) r.add(e);
  (projectSearch as unknown as { state: object }).state = { ...projectSearch.get(), results: r, active: null };
  const opened: unknown[] = [];
  const off = registerCodeCommand("file.open", (args) => void opened.push(args));
  expect(projectSearch.step(1)).toBe(false);
  off();
  expect(opened).toEqual([]);
});

test("search.project's regex flag searches again when the text is the same", async () => {
  registerProjectSearchCommands();
  projectSearch.set({ options: { regex: false } });
  gates.delete("needle");
  projectSearch.schedule("needle", { immediate: true });
  await until(() => gates.has("needle"));
  gates.get("needle")!();
  await until(() => !projectSearch.get().running);
  gates.delete("needle");
  const before = requests.length;
  const { runCodeCommand } = await import("../../commands");
  runCodeCommand("search.project", { query: "needle", regex: true });
  await until(() => gates.has("needle"));
  gates.get("needle")!();
  await until(() => !projectSearch.get().running);
  expect(requests.slice(before)).toEqual(["needle"]);
  expect(regexFlags[regexFlags.length - 1]).toBe(true);
  projectSearch.set({ options: { regex: false } });
});
