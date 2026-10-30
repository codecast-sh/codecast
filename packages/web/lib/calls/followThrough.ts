// What came of each call: its asks (the summary's action items and the tasks
// pulled from it), and for each one who picked it up and where it stands.
// Pure, over store rows, so the calls page derives it at render and a task
// moving anywhere moves its row here at once.

export type FollowStage = "unfiled" | "guessed" | "filed" | "working" | "deciding" | "review" | "done" | "dropped";

/** Left to right, the way an ask travels. */
export const FOLLOW_STAGES: FollowStage[] = ["unfiled", "guessed", "filed", "working", "deciding", "review", "done"];

export type FollowItem = {
  key: string;
  title: string;
  /** Who the summary asked it of ("Samvit: ..."), when it said. */
  askedOf?: string;
  task?: any;
  /** The action item as the summary wrote it, for an ask no task names. */
  raw?: string;
  /** For an ask no task names word for word: the task whose title reads most
   *  like it, shown as a guess and never counted as filing it. */
  guess?: any;
  /** Sessions working the task, newest first, the one that filed it left out. */
  sessions: string[];
  decisions: any[];
  stage: FollowStage;
};

export type FollowCall = {
  call: any;
  items: FollowItem[];
  sweepDocs: any[];
  counts: Record<FollowStage, number>;
};

const STOP = new Set(
  "the and for with that this from into about what when then them they their have will should would could make take each look check start keep after before also just like more some than over onto your ours".split(" "),
);

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );

/** Normalized title, so an action item finds the task made from it word for word. */
export const itemKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.]+$/, "");

function overlap(item: string, title: string): number {
  const a = words(item);
  const b = words(title);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  // Two shared words say little ("Ship the mobile build" and "Fix the mobile
  // build signing" share two): a match needs three, and most of the shorter.
  return shared >= 3 ? shared / Math.min(a.size, b.size) : 0;
}

/** The task made from a call's action item: the same title, word for word
 *  (with or without the "Name:" prefix). The only rule that counts an ask as
 *  filed, on the call page and the board alike. */
export function taskForItem<T extends { title?: string }>(item: string, tasks: T[]): T | undefined {
  const keys = [itemKey(item), itemKey(splitAsk(item).text)];
  return tasks.find((t) => keys.includes(itemKey(t.title ?? "")));
}

/** The task whose title reads most like an action item the listener may have
 *  reworded: three shared content words and most of the shorter. A guess for a
 *  person to confirm, since one common extra word can carry it. */
export function likelyTaskForItem<T extends { title?: string }>(item: string, tasks: T[]): T | undefined {
  const text = splitAsk(item).text;
  let best: T | undefined;
  let bestScore = 0.6;
  for (const t of tasks) {
    const score = overlap(text, t.title ?? "");
    if (score >= bestScore) [best, bestScore] = [t, score];
  }
  return best;
}

/** "Samvit: look into X" → { who: "Samvit", text: "look into X" }, when the
 *  prefix names someone on the call; "Note: ..." stays whole. With no names
 *  given, any short capitalized prefix counts. */
export function splitAsk(item: string, names?: string[]): { who?: string; text: string } {
  const m = /^([A-Z][\w.' -]{0,40}?):\s+(.+)$/.exec(item.trim());
  if (!m) return { text: item.trim() };
  const who = m[1].trim();
  const known = (n: string) => n.toLowerCase() === who.toLowerCase() || n.split(/\s+/)[0]?.toLowerCase() === who.toLowerCase();
  if (names && !names.some(known)) return { text: item.trim() };
  return { who, text: m[2].trim() };
}

function taskStage(task: any, sessions: string[], decisions: any[]): FollowStage {
  if (task.status === "done") return "done";
  if (task.status === "dropped") return "dropped";
  if (decisions.some((d) => d.status === "pending")) return "deciding";
  if (task.status === "in_review") return "review";
  if (task.status === "in_progress" || sessions.length > 0) return "working";
  return "filed";
}

/** The sweep docs' titles name the calls they read: "cl-176 to cl-180",
 *  "cl-172 and cl-173", "cl-171, plus cl-170". */
export function sweepCallNumbers(title: string): number[] {
  if (!/call ideas sweep/i.test(title)) return [];
  const out = new Set<number>();
  for (const m of title.matchAll(/cl-(\d+)\s+to\s+cl-(\d+)/gi)) {
    const [from, to] = [Number(m[1]), Number(m[2])];
    // A sweep reads a few days of calls; a wider span is a typo, not a range.
    if (to - from > 50) continue;
    for (let n = from; n <= to; n++) out.add(n);
  }
  for (const m of title.matchAll(/cl-(\d+)/gi)) out.add(Number(m[1]));
  return [...out];
}

export function buildFollowThrough(
  calls: any[],
  tasks: any[],
  decisions: any[],
  docs: any[],
): FollowCall[] {
  const tasksByCall = new Map<string, any[]>();
  for (const t of tasks) {
    if (!t.from_call) continue;
    const list = tasksByCall.get(t.from_call) ?? [];
    list.push(t);
    tasksByCall.set(t.from_call, list);
  }
  const decisionsByTask = new Map<string, any[]>();
  for (const d of decisions) {
    if (!d.task_id || d.status === "withdrawn") continue;
    const list = decisionsByTask.get(String(d.task_id)) ?? [];
    list.push(d);
    decisionsByTask.set(String(d.task_id), list);
  }
  const docsByCall = new Map<number, any[]>();
  for (const d of docs) {
    for (const n of sweepCallNumbers(d.title ?? "")) {
      const list = docsByCall.get(n) ?? [];
      list.push(d);
      docsByCall.set(n, list);
    }
  }

  return calls.map((call) => {
    const callTasks = (tasksByCall.get(String(call._id)) ?? []).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    const items: FollowItem[] = callTasks.map((task) => {
      const filer = task.created_from_conversation ? String(task.created_from_conversation) : null;
      const sessions = [...(task.conversation_ids ?? [])].map(String).filter((id) => id !== filer).reverse();
      const decs = (decisionsByTask.get(String(task._id)) ?? []).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
      return { key: String(task._id), title: task.title, task, sessions, decisions: decs, stage: taskStage(task, sessions, decs) };
    });
    // A summary's action item no task took up is an ask nobody filed.
    const names = (call.participants ?? []).map((p: any) => String(p.name ?? ""));
    for (const raw of call.action_items ?? []) {
      if (taskForItem(raw, callTasks)) continue;
      const { who, text } = splitAsk(raw, names);
      const guess = likelyTaskForItem(raw, callTasks);
      items.push({ key: `ask:${raw}`, raw, title: text, askedOf: who, guess, sessions: [], decisions: [], stage: guess ? "guessed" : "unfiled" });
    }
    const counts = Object.fromEntries([...FOLLOW_STAGES, "dropped"].map((s) => [s, 0])) as Record<FollowStage, number>;
    for (const it of items) counts[it.stage]++;
    const num = Number(/^cl-(\d+)$/.exec(call.short_id ?? "")?.[1]);
    return { call, items, sweepDocs: Number.isFinite(num) ? docsByCall.get(num) ?? [] : [], counts };
  });
}
