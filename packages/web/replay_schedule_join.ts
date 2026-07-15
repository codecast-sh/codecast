// Throwaway diagnostic: replay the inbox schedule join with REAL prod data as
// the real user. Run: bun replay_schedule_join.ts   (delete after use)
import { SignJWT, importPKCS8 } from "/Users/ashot/src/codecast/node_modules/.bun/jose@5.10.0/node_modules/jose/dist/node/esm/index.js";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { partitionScheduleInbox, type TaskRow } from "./components/scheduleTasks";
import type { InboxSession } from "./store/inboxStore";

const USER_ID = "kd700q4pr2m98a3nghfesw4vxx7wkn6z";
const ISS = "https://convex.codecast.sh";

function normalizePem(raw: string): string {
  const body = raw
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

const pem = normalizePem(process.env.JWT_PRIVATE_KEY!);
const key = await importPKCS8(pem, "RS256");
const jwt = await new SignJWT({})
  .setProtectedHeader({ alg: "RS256" })
  .setSubject(`${USER_ID}|jh72nnwvdjk91b30zcsts7c99d8a8tvm`)
  .setIssuer(ISS)
  .setAudience("convex")
  .setIssuedAt()
  .setExpirationTime("2h")
  .sign(key);

const client = new ConvexHttpClient(ISS);
client.setAuth(jwt);

const webList = makeFunctionReference<"query">("agentTasks:webList");
const listInbox = makeFunctionReference<"query">("conversations:listInboxSessions");

const tasks = (await client.query(webList, {})) as TaskRow[];
const inboxResult = (await client.query(listInbox, {
  show_all: false,
  include_liveness: false,
})) as { sessions: InboxSession[]; hidden_count: number };
const sessions = inboxResult.sessions;

console.log(`webList: ${tasks.length} tasks (${tasks.filter((t) => ["scheduled", "running", "paused"].includes(t.status)).length} armed)`);
console.log(`listInboxSessions: ${sessions.length} sessions`);

const sessionsById: Record<string, InboxSession> = {};
for (const s of sessions) sessionsById[s._id] = s;

const partition = partitionScheduleInbox(tasks, sessionsById, {});
console.log(`\npartition.rows: ${partition.rows.length}`);
console.log(`partition.absorbedIds: ${partition.absorbedIds.size}`);

// Replay of GlobalSessionPanel.scheduleBarRowsFor for every session row.
let barCount = 0;
for (const sess of sessions) {
  const bars = partition.rows.filter(
    (r) =>
      r.task.originating_conversation_id === sess._id ||
      (!!sess.agent_task_id && r.task._id === sess.agent_task_id),
  );
  if (bars.length) {
    barCount += bars.length;
    console.log(
      `BAR under [${sess._id.slice(-7)}] "${(sess.title ?? "").slice(0, 40)}" (absorbed=${partition.absorbedIds.has(sess._id)}, pinned=${!!sess.is_pinned}): ${bars
        .map((b) => b.task.title?.slice(0, 30))
        .join(" | ")}`,
    );
  }
}
console.log(`\ntotal bars: ${barCount}`);

for (const r of partition.rows) {
  const oc = r.task.originating_conversation_id;
  console.log(
    `row: "${(r.task.display_title || r.task.title || "").slice(0, 38)}" originating=${oc ? oc.slice(-7) : "NONE"} inStore=${oc ? !!sessionsById[oc] : "-"} openId=${r.openId ? r.openId.slice(-7) : "-"}`,
  );
}
