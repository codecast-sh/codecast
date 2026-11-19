// What the list rows of `tasks` and `pullRequests` weigh with and without the
// fields lib/detailRows keeps off them, at the size of a real account.
//
//   bun perf/detailRowsSize.ts
//
// The rows are synthetic, generated from the shape measured in one window of
// the desktop app on 2026-11-18 (the numbers in MEASURED): how many rows, how
// many comments and files each, how long a comment and a patch run, at the
// median and in the tail. The script prints how close the synthetic set comes
// to the measured bytes, then pushes it through the store's own sync path
// (syncTable, as every feeder does) and prints what the collections hold.
import { useInboxStore } from "../store/inboxStore";
import { holdTaskThreads } from "../hooks/useSyncTasks";
import { applyPullRequestAnswer } from "../hooks/useSyncTimeline";
import { MAX_CACHED_PULL_REQUEST_DETAILS } from "../store/cacheRetention";

const MEASURED = {
  tasks: {
    rows: 7919, rowBytes: 32_164_488, commentBytes: 17_395_127, comments: 13_565, withComments: 4467, causeRows: 756,
    // Quantiles at 0.5, 0.75, 0.9, 0.99 and the maximum.
    perTaskCount: [1, 2, 4, 16, 192], textLength: [450, 784, 1633, 5365, 35_868],
  },
  prs: {
    rows: 253, full: 199, rowBytes: 36_085_445, filesBytes: 28_713_284, commitsBytes: 3_823_342, checksBytes: 2_381_772, bodyBytes: 867_551,
    files: 5957, fileCount: [9, 33, 83, 100, 100], patchLength: [2023, 4883, 10_409, 49_500, 51_233],
    // Commits and checks were read at 0.5, 0.9 and the maximum only.
    commits: 3395, commitCount: [2, 27, 250], checks: 7744, checkCount: [33, 54, 87],
  },
};

// Deterministic, so two runs print the same numbers.
let seed = 0x2f6e2b1;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Stops = Array<[at: number, value: number]>;
/** The value at quantile `u` of the distribution these stops describe. Below the first stop it is 0 (the rows that
 *  have none). Between two stops the value moves from the lower to the upper on a log scale, bent by `gamma`: above 1
 *  it stays near the lower stop for longer, which is how real counts and lengths sit inside a quantile band. */
function quantile(u: number, stops: Stops, gamma: number): number {
  if (u < stops[0][0]) return 0;
  for (let i = 1; i < stops.length; i++) {
    const [p1, v1] = stops[i];
    if (u > p1) continue;
    const [p0, v0] = stops[i - 1];
    const f = p1 === p0 ? 1 : ((u - p0) / (p1 - p0)) ** gamma;
    return Math.round(Math.exp(Math.log(v0) + f * (Math.log(v1) - Math.log(v0))));
  }
  return stops[stops.length - 1][1];
}
/** `n` draws from the stops whose sum is the measured `total`: the stops fix the quantiles, and the bend inside each
 *  band is searched for until the sum agrees, so the set matches the measurement in its quantiles and its bytes. */
function calibrated(n: number, stops: Stops, total: number): number[] {
  const us = Array.from({ length: n }, rand);
  const sum = (gamma: number) => us.reduce((acc, u) => acc + quantile(u, stops, gamma), 0);
  let lo = 0.05;
  let hi = 40;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (sum(mid) > total) lo = mid; else hi = mid;
  }
  return us.map((u) => quantile(u, stops, hi));
}
// Spaces only: nothing JSON escapes, so a string's length is its bytes.
const WORDS = "the run handed this problem back at refine because nine of twelve findings reject the cause as stated and the proof could not reproduce it on main".split(" ");
function text(length: number): string {
  let out = "";
  while (out.length < length) out += WORDS[Math.floor(rand() * WORDS.length)] + " ";
  return out.slice(0, length);
}
const cid = (prefix: string, n: number) => `${prefix}${String(n).padStart(32 - prefix.length, "0")}`;
const bytes = (v: unknown) => JSON.stringify(v).length;
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function makeTasks() {
  const m = MEASURED.tasks;
  const none = 1 - m.withComments / m.rows;
  const counts = calibrated(m.rows, [[none, 1], [0.5, m.perTaskCount[0]], [0.75, m.perTaskCount[1]], [0.9, m.perTaskCount[2]], [0.99, m.perTaskCount[3]], [1, m.perTaskCount[4]]], m.comments);
  const comment = (taskId: string, n: number, c: number, body: string) => {
    const at = 1_760_000_000_000 + c * 1000;
    return {
      _creationTime: at + 0.123, _id: cid("j97", c), author: "claude", comment_type: "progress", conversation_id: cid("jx7", n),
      created_at: at, task_id: taskId, text: body,
      session_info: { _id: cid("jx7", n), session_id: `0195e2d1-7c3a-7e2b-9f4d-${String(n).padStart(12, "0")}`, title: "Fix the retry queue backoff", agent_type: "claude_code", author_name: "Alexander Green", short_id: "jx7a2rz", updated_at: at, is_active: false },
    };
  };
  const row = (n: number, description: string, comments: any[]) => {
    const _id = cid("k17", n);
    return {
      _id, _creationTime: 1_760_000_000_000 + n, short_id: `ct-${n}`, title: text(60), description,
      status: n % 100 < 59 ? "done" : "open", priority: "medium", task_type: "task", source: "agent", user_id: cid("k57", 1), team_id: cid("kd7", 1),
      workspace: `team:${cid("kd7", 1)}`, created_at: 1_760_000_000_000 + n, updated_at: 1_762_000_000_000 + n, last_comment_at: comments.length ? 1_762_000_000_000 + n : undefined,
      labels: ["sync", "web"], conversation_ids: [cid("jx7", n)], session_count: 1, project_id: cid("kh7", n % 40),
      creator: { name: "Alexander Green", image: "https://avatars.githubusercontent.com/u/0000000?v=4", github_username: "alex" }, assignee_info: null, plan: null,
      verification_evidence: n % 5 === 0 ? text(900) : undefined, steps: [{ title: text(50), done: true }, { title: text(50), done: false }],
      graph_status: "ok", execution_status: "idle", triage_status: "active", client_key: `tk-${n}`,
      ...(n < m.causeRows ? { cause: { signal_count: 3, fingerprints: [`fp-${n}`], kind: "code" } } : {}),
      comments,
    };
  };
  // What a comment and a row weigh with no text in them; the text makes up the rest of the measured bytes.
  const emptyComment = bytes(comment(cid("k17", 0), 0, 0, "")) + 1;
  const lengths = calibrated(total(counts), [[0, 20], [0.5, m.textLength[0]], [0.75, m.textLength[1]], [0.9, m.textLength[2]], [0.99, m.textLength[3]], [1, m.textLength[4]]], m.commentBytes - total(counts) * emptyComment);
  const emptyRow = bytes(row(0, "", [])) + 40;
  // Everything else on a row (its description, evidence, steps): no quantiles were read for these, only their bytes.
  const descriptions = calibrated(m.rows, [[0, 1], [0.5, 300], [0.75, 900], [0.9, 2500], [0.99, 12_000], [1, 40_000]], m.rowBytes - m.commentBytes - m.rows * emptyRow);
  let c = 0;
  return counts.map((count, n) => row(n, text(descriptions[n]), Array.from({ length: count }, () => comment(cid("k17", n), n, c, text(lengths[c++])))));
}

function makePullRequests() {
  const m = MEASURED.prs;
  const chip = 1 - m.full / m.rows;
  const fileCounts = calibrated(m.rows, [[chip, 1], [0.5, m.fileCount[0]], [0.75, m.fileCount[1]], [0.9, m.fileCount[2]], [0.99, m.fileCount[3]], [1, m.fileCount[4]]], m.files);
  const commitCounts = calibrated(m.rows, [[chip, 1], [0.5, m.commitCount[0]], [0.9, m.commitCount[1]], [1, m.commitCount[2]]], m.commits);
  const checkCounts = calibrated(m.rows, [[chip, 20], [0.5, m.checkCount[0]], [0.9, m.checkCount[1]], [1, m.checkCount[2]]], m.checks);
  const file = (n: number, i: number, patch: string) => ({ filename: `packages/web/components/area${n}/File${i}.tsx`, status: "modified", additions: 12, deletions: 4, changes: 16, patch });
  const commit = (i: number, message: string) => ({
    sha: String(i).padStart(40, "a"), message, author_name: "Alexander Green", author_login: "alex",
    author_avatar_url: "https://avatars.githubusercontent.com/u/0000000?v=4", committed_at: 1_762_000_000_000 + i, url: `https://github.com/codecast-sh/codecast/commit/${String(i).padStart(40, "a")}`,
  });
  const check = (i: number) => ({
    app: "github-actions", external_id: String(53_000_000_000 + i), name: `test-web (${i}/4)`, status: "completed", conclusion: "success", event: "pull_request",
    suite_id: String(41_000_000_000 + i), updated_at: 1_762_000_000_000 + i, url: `https://github.com/codecast-sh/codecast/actions/runs/19000000000/job/${53_000_000_000 + i}`,
  });
  const patches = calibrated(total(fileCounts), [[0, 40], [0.5, m.patchLength[0]], [0.75, m.patchLength[1]], [0.9, m.patchLength[2]], [0.99, m.patchLength[3]], [1, m.patchLength[4]]], m.filesBytes - total(fileCounts) * (bytes(file(100, 10, "")) + 1));
  const messages = calibrated(total(commitCounts), [[0, 30], [0.5, 500], [0.75, 1100], [0.9, 2400], [0.99, 6000], [1, 12_000]], m.commitsBytes - total(commitCounts) * (bytes(commit(1, "")) + 1));
  const bodies = calibrated(m.full, [[0, 100], [0.5, 2500], [0.75, 5000], [0.9, 9000], [0.99, 20_000], [1, 40_000]], m.bodyBytes - m.full * 2);
  let f = 0;
  let c = 0;
  return fileCounts.map((fileCount, n) => {
    const base = {
      _id: cid("pd7", n), _creationTime: 1_760_000_000_000 + n, team_id: cid("kd7", 1), repository: "codecast-sh/codecast", number: 1000 + n,
      title: text(80), state: n % 3 ? "merged" : "open", draft: false, checks_state: "success", author_github_username: "alex",
      author_avatar_url: "https://avatars.githubusercontent.com/u/0000000?v=4", head_ref: `fix/branch-${n}`, base_ref: "main",
      head_sha: "f".repeat(40), base_sha: "e".repeat(40), created_at: 1_760_000_000_000 + n, updated_at: 1_762_000_000_000 + n,
      linked_session_ids: [cid("jx7", n), cid("jx7", n + 1)], labels: [{ name: "perf", color: "ededed" }],
    };
    // A row only the inbox chip feed wrote: no body, no detail.
    if (fileCount === 0) return base;
    const files = Array.from({ length: fileCount }, (_, i) => file(n, i, text(patches[f++])));
    const commits = Array.from({ length: Math.max(1, commitCounts[n]) }, (_, i) => commit(i, text(messages[c++] ?? 200)));
    const checks = Array.from({ length: Math.max(1, checkCounts[n]) }, (_, i) => check(i));
    return { ...base, body: text(bodies[Math.min(n, bodies.length - 1)]), additions: 320, deletions: 90, changed_files: files.length, commits_count: commits.length, files_synced_at: 1_762_000_000_000, files, commits, checks };
  });
}

const state = () => useInboxStore.getState() as any;
const collectionBytes = (key: string) => bytes(state()[key] ?? {});

// ── Tasks ──
const tasks = makeTasks();
const taskFat = bytes(Object.fromEntries(tasks.map((t) => [t._id, t])));
const taskCommentBytes = tasks.reduce((n, t) => n + bytes(t.comments), 0);
console.log(`tasks: ${tasks.length} rows, ${tasks.reduce((n, t) => n + t.comments.length, 0)} comments (measured ${MEASURED.tasks.comments})`);
console.log(`  synthetic rows with comments on them: ${mb(taskFat)}, comments ${mb(taskCommentBytes)}   (measured ${mb(MEASURED.tasks.rowBytes)}, comments ${mb(MEASURED.tasks.commentBytes)})`);
useInboxStore.setState({ tasks: {}, taskComments: {}, pullRequests: {}, pullRequestDetails: {}, pending: {} } as any);
for (let i = 0; i < tasks.length; i += 100) state().syncTable("tasks", tasks.slice(i, i + 100), { isDelta: true });
const taskThin = collectionBytes("tasks");
console.log(`  BEFORE  tasks list rows: ${mb(taskFat)}`);
console.log(`  AFTER   tasks list rows: ${mb(taskThin)}   threads held: ${mb(collectionBytes("taskComments"))} (nothing opened)`);
// The line app open: it reads the thread of every problem.
holdTaskThreads(tasks.filter((t) => t.cause));
console.log(`  AFTER, with the line open (${MEASURED.tasks.causeRows} problems' threads): list rows ${mb(collectionBytes("tasks"))} + threads ${mb(collectionBytes("taskComments"))}`);

// ── Pull requests ──
const prs = makePullRequests();
const prFat = bytes(Object.fromEntries(prs.map((p) => [p._id, p])));
const part = (f: string) => prs.reduce((n, p) => n + (p[f] === undefined ? 0 : bytes(p[f])), 0);
console.log(`\npull requests: ${prs.length} rows, ${prs.reduce((n, p) => n + (p.files?.length ?? 0), 0)} files (measured ${MEASURED.prs.files}), ${prs.reduce((n, p) => n + (p.commits?.length ?? 0), 0)} commits (measured ${MEASURED.prs.commits}), ${prs.reduce((n, p) => n + (p.checks?.length ?? 0), 0)} checks (measured ${MEASURED.prs.checks})`);
console.log(`  synthetic rows with detail on them: ${mb(prFat)}: files ${mb(part("files"))}, commits ${mb(part("commits"))}, checks ${mb(part("checks"))}, body ${mb(part("body"))}`);
console.log(`  measured:                           ${mb(MEASURED.prs.rowBytes)}: files ${mb(MEASURED.prs.filesBytes)}, commits ${mb(MEASURED.prs.commitsBytes)}, checks ${mb(MEASURED.prs.checksBytes)}, body ${mb(MEASURED.prs.bodyBytes)}`);
state().syncTable("pullRequests", prs, { isDelta: true });
console.log(`  BEFORE  pullRequests list rows: ${mb(prFat)}`);
console.log(`  AFTER   pullRequests list rows: ${mb(collectionBytes("pullRequests"))}   detail held: ${mb(collectionBytes("pullRequestDetails"))} (nothing opened)`);
const full = prs.filter((p) => p.files);
const typical = [...full].sort((a, b) => bytes(a.files) - bytes(b.files))[Math.floor(full.length / 2)];
applyPullRequestAnswer(typical);
console.log(`  AFTER, one pull request's page open (the median one): detail held ${(collectionBytes("pullRequestDetails") / 1e3).toFixed(0)} KB; the mean detail is ${((part("files") + part("commits") + part("checks")) / full.length / 1e3).toFixed(0)} KB`);
// What the cache carries across a restart, and so what every window reads at boot: the retention cap.
useInboxStore.setState({ pullRequestDetails: {} } as any);
for (const p of full.slice(0, MAX_CACHED_PULL_REQUEST_DETAILS)) applyPullRequestAnswer(p);
console.log(`  AFTER, kept across a restart (the cap, ${MAX_CACHED_PULL_REQUEST_DETAILS} opened pull requests): detail held ${mb(collectionBytes("pullRequestDetails"))}`);
useInboxStore.setState({ pullRequestDetails: {} } as any);
const heaviest = [...full].sort((a, b) => bytes(b.files) - bytes(a.files)).slice(0, MAX_CACHED_PULL_REQUEST_DETAILS);
for (const p of heaviest) applyPullRequestAnswer(p);
console.log(`  AFTER, the same cap filled with the ${MAX_CACHED_PULL_REQUEST_DETAILS} heaviest: detail held ${mb(collectionBytes("pullRequestDetails"))}`);

const before = taskFat + prFat;
const after = taskThin + collectionBytes("pullRequests");
console.log(`\nboth lists, always loaded in every window: ${mb(before)} before, ${mb(after)} after (${Math.round((1 - after / before) * 100)}% less)`);
process.exit(0);
