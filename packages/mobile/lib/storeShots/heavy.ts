// A heavy account for perf runs, layered over the Acme world in store shots
// mode: EXPO_PUBLIC_STORE_SHOTS_HEAVY=<sessions> adds that many sessions and
// keeps a live set of them heartbeating the way prod pushes do (the
// sessionsLiveness overlay every ~1.5 s, the live inbox window re-sending the
// rows that stream). Shaped on the account that reported the phone hanging
// (2026-11-08): ~1,500 cached sessions, ~55 of them top-level and the rest
// subagents nested under those, ~120 alive at once.
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { INBOX_FACT_FIELDS } from "@codecast/shared/contracts";
import { CURRENT_USER, TEAM_ID } from "./world";

export const HEAVY_SESSIONS = Number(process.env.EXPO_PUBLIC_STORE_SHOTS_HEAVY ?? 0) || 0;
const LIVE = 120;
const TOP = 55;
const MIN = 60_000;
const PROJECTS = ["littlebird", "littlebird", "littlebird", "lb2", ".claude", "union", "codecast"];

const heavyId = (i: number) => `jx7heavy${String(i).padStart(24, "0")}`;

function heavyRow(i: number, now: number, me: string) {
  const live = i < LIVE;
  const at = now - (live ? (i % 20) * 15_000 : 5 * MIN + i * 20_000);
  const child = i >= TOP;
  const project = `~/src/${PROJECTS[i % PROJECTS.length]}`;
  return {
    _id: heavyId(i),
    session_id: `${heavyId(i)}-sess`,
    short_id: `hv${i}`,
    title: `${["iOS chat polish", "Feature flag redesign", "PostHog key vault", "Watchdog sleep", "POST /stt 500 fix"][i % 5]} ${i}`,
    agent_type: i % 9 ? "claude_code" : "codex",
    user_id: me,
    is_own: true,
    status: "active",
    team_id: TEAM_ID,
    project_path: project,
    git_root: project,
    git_branch: "main",
    message_count: 40 + (i % 300),
    started_at: at - 40 * MIN,
    updated_at: at,
    last_message_at: at,
    is_connected: live,
    daemon_alive_until: live ? now + 10 * MIN : now - MIN,
    last_heartbeat: live ? now - 2_000 : at,
    agent_status: live ? (i % 3 ? "working" : "idle") : i % 2 ? "done" : "idle",
    agent_status_at: at,
    is_idle: !(live && i % 3),
    awaiting_input: false,
    has_pending: false,
    last_turn_allows_park: false,
    thread_state: `Working on item ${i}\nStatus: step ${i % 7} of 7`,
    last_message_preview: `Reviewed the diff for change ${i} and pushed the fix.`,
    subtitle: `Change ${i}`,
    ...(child ? { is_subagent: true, parent_conversation_id: heavyId(i % TOP), parent_message_uuid: `hv-msg-${i}` } : {}),
  };
}

// The first heavy session's transcript: a long agent run, the mix a real one
// carries (markdown answers with lists, fences and tables; tool calls with
// their output; a person's turn every couple dozen rows), for scroll runs.
const LONG_ROWS = 600;
const FENCE = "```";
function longTranscript(now: number) {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < LONG_ROWS; i++) {
    const timestamp = now - (LONG_ROWS - i) * 20_000;
    const _id = `hv-long-${i}`;
    if (i % 24 === 0) {
      out.push({ _id, role: "user", content: `Next: tighten the retry path for case ${i}. Keep deliver() as is and add a test for the 429 branch.`, timestamp });
    } else if (i % 3 === 1) {
      const id = (k: number) => `hv-tc-${i}-${k}`;
      const bash = Array.from({ length: 12 + (i % 18) }, (_, k) => `src/api/hooks.test.ts:${k + 10}  ✓ retries case ${k} (${(k * 7) % 40}ms)`).join("\n");
      const read = Array.from({ length: 30 }, (_, k) => `${k + 1}\texport function step${k}(e: Event) { return deliver(e, { attempt: ${k} }) }`).join("\n");
      out.push({
        _id, role: "assistant", content: i % 2 ? "Checking the current behavior first." : "",
        tool_calls: [
          { id: id(0), name: "Read", input: JSON.stringify({ file_path: `src/api/retry${i % 9}.ts` }) },
          { id: id(1), name: "Bash", input: JSON.stringify({ command: `bun test src/api/hooks.test.ts -t case${i}` }) },
          ...(i % 2 ? [{ id: id(2), name: "Edit", input: JSON.stringify({ file_path: `src/api/retry${i % 9}.ts`, old_string: "attempt < 5", new_string: "attempt < MAX_ATTEMPTS" }) }] : []),
        ],
        tool_results: [
          { tool_use_id: id(0), content: read },
          { tool_use_id: id(1), content: `${bash}\n${12 + (i % 18)} pass\n0 fail` },
          ...(i % 2 ? [{ tool_use_id: id(2), content: `The file src/api/retry${i % 9}.ts has been updated.` }] : []),
        ],
        timestamp,
      });
    } else {
      const parts = [
        `The 429 branch for case ${i} retried immediately, which is why the limiter kept rejecting it. **Root cause:** the backoff read \`attempt\` before incrementing it, so the first wait was 0.`,
        `- Backoff now starts at 2s and doubles\n- Jitter is ±20% so a burst does not retry in lockstep\n- After the fifth attempt the delivery is marked \`failed\` and stops`,
      ];
      if (i % 4 === 0) parts.push(`${FENCE}ts\nexport function backoff(attempt: number) {\n  const base = 2_000 * 2 ** attempt;\n  return base * (0.8 + Math.random() * 0.4);\n}\n${FENCE}`);
      if (i % 10 === 0) parts.push(`| Attempt | Wait | Status |\n| --- | --- | --- |\n| 1 | 2s | 429 |\n| 2 | 4s | 429 |\n| 3 | 8s | 200 |`);
      out.push({ _id, role: "assistant", content: parts.join("\n\n"), timestamp });
    }
  }
  return out;
}

export function seedHeavy(now = Date.now()) {
  if (!HEAVY_SESSIONS) return;
  const me = CURRENT_USER(now)._id;
  const st = useInboxStore.getState();
  const rows = Array.from({ length: HEAVY_SESSIONS }, (_, i) => heavyRow(i, now, me));
  rows[0] = { ...rows[0], title: "Long transcript", message_count: LONG_ROWS };
  st.syncTable("sessions", rows as any);
  st.syncRecord("conversations", rows[0]._id, rows[0] as any);
  st.applyTailMessages(rows[0]._id, 0, longTranscript(now) as any, null);
  st.setLiveInboxIds([...Object.keys(useInboxStore.getState().sessions)]);
  const liveIds = rows.slice(0, LIVE).map((r) => r._id);
  let beat = 0;
  // The liveness overlay: every live row's facts, with a fresh heartbeat.
  setInterval(() => {
    beat++;
    const t = Date.now();
    const cur = useInboxStore.getState().sessions as Record<string, any>;
    const liveness: Record<string, Record<string, unknown>> = {};
    for (const id of liveIds) {
      const row: Record<string, unknown> = {};
      for (const key of INBOX_FACT_FIELDS) row[key] = cur[id]?.[key] ?? null;
      row.last_heartbeat = t;
      row.daemon_alive_until = t + 10 * MIN;
      liveness[id] = row;
    }
    useInboxStore.getState().applyInboxLivenessPayload("mine", { liveness });
    // The live window re-sends the rows that streamed a message.
    if (beat % 2 === 0) {
      const streamed = liveIds.filter((_, k) => (k + beat) % 12 === 0).map((id) => ({
        ...cur[id],
        updated_at: t,
        last_message_at: t,
        message_count: (cur[id]?.message_count ?? 0) + 1,
      }));
      useInboxStore.getState().syncTable("sessions", streamed as any, { isDelta: true });
    }
  }, 1_500);
}
