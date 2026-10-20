// The render gallery (lib/renderGallery.ts) holds a row for every kind of thing
// a transcript draws. This test fails when a renderer learns something the
// gallery does not show: a new user-row kind, fence, tool family, `cast`
// command card, system subtype or failure banner. Fix it by adding the row to
// the gallery, not by loosening the test.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { renderGalleryMessages } from "../renderGallery";
import { classifyUserRows } from "../userRowKinds";
import { parseApiErrorContent, parseCastCommand } from "../../components/conversation/classify";
import { normalizeCastCategory } from "../../components/castCommand";
import type { UserMessageKind } from "../../components/conversation/types";
import { CLOUD_AGENT_ACTION_SUBTYPE } from "@codecast/shared/contracts";
import { LINE_FENCE_LANG } from "@codecast/shared/contracts/lineChat";
import { VIEW_FENCE_LANG } from "../productViewRefs";
import { DIFF_FENCE } from "../castDiff";

const ROOT = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const rows = renderGalleryMessages(1_790_000_000_000);
const timeline = rows.map((m) => ({ type: "message" as const, data: m as any, timestamp: m.timestamp }));
const kinds = classifyUserRows(timeline, rows as any, { agentType: "claude_code" });

// Every kind the classifier returns. `true` means the gallery shows it; a
// string says why no message can reach it. The type makes a new kind a compile
// error here until it is placed.
const USER_ROW_KINDS: Record<UserMessageKind["kind"], true | string> = {
  normal: true,
  session_handoff: true,
  command: true,
  bash_input: true,
  bash_output: true,
  interrupt: true,
  background_agent_stopped: true,
  skill_expansion: true,
  task_notification: true,
  task_prompt: "classify returns noise for an empty row before it can test for a task prompt",
  compaction_prompt: true,
  compaction_summary: true,
  plan: true,
  noise: true,
  tool_results_only: true,
  empty: true,
  teammate_events: true,
  continuation: true,
  poll_response: true,
  scheduled_task: true,
  role_brief: true,
  machine_move: true,
  agent_switch: true,
  session_message: true,
  direct_user: true,
  huddle_summary: true,
  chat_wake: true,
  decision_answer: true,
  session_escalation: true,
};

const assistantText = rows.filter((r) => r.role === "assistant").map((r) => r.content);
const toolNames = new Set(rows.flatMap((r) => r.tool_calls?.map((c) => c.name) ?? []));
const casts = rows.flatMap((r) => r.tool_calls ?? []).map((c) => parseCastCommand(c as any)).filter((c) => !!c);

describe("render gallery", () => {
  test("ids are unique and prefixed, timestamps ascend", () => {
    expect(new Set(rows.map((r) => r._id)).size).toBe(rows.length);
    expect(rows.every((r) => r._id.startsWith("gallery-"))).toBe(true);
    expect(rows.every((r, i) => i === 0 || r.timestamp > rows[i - 1].timestamp)).toBe(true);
  });

  test("shows every user-row kind", () => {
    const seen = new Set([...kinds.values()].map((k) => k.kind));
    const missing = Object.entries(USER_ROW_KINDS).filter(([k, v]) => v === true && !seen.has(k as UserMessageKind["kind"])).map(([k]) => k);
    expect(missing, "add a gallery row of each kind").toEqual([]);
    const unreachable = Object.entries(USER_ROW_KINDS).filter(([k, v]) => v !== true && seen.has(k as UserMessageKind["kind"])).map(([k]) => k);
    expect(unreachable, "these became reachable: mark them true").toEqual([]);
  });

  test("shows every fence renderFence draws", () => {
    const src = read("web/lib/fenceRenderers.tsx");
    const body = src.slice(src.indexOf("export function renderFence("), src.indexOf("export function renderPre("));
    const known: Record<string, string> = {
      '"mermaid"': "mermaid",
      LINE_FENCE_LANG,
      VIEW_FENCE_LANG,
      tryRenderCanvas: "cast-canvas",
      tryRenderCastDiff: DIFF_FENCE,
    };
    const branches = [...body.matchAll(/language === ([\w"]+)|(tryRender\w+)\(language/g)].map((m) => m[1] ?? m[2]);
    expect(branches.filter((b) => !(b in known)), "a new fence: add it to the gallery and to `known`").toEqual([]);
    const fences = new Set(assistantText.flatMap((c) => [...c.matchAll(/^(?:```|~~~)([\w-]+)/gm)].map((m) => m[1])));
    expect(Object.values(known).filter((lang) => !fences.has(lang))).toEqual([]);
    // A language nothing claims (a mod's, or a plain code block) and a text fence.
    expect(fences.has("gallery-mod-fence") && fences.has("text") && fences.has("ts")).toBe(true);
  });

  test("calls a tool of every family", () => {
    const src = read("shared/render/toolKinds.ts");
    const families = [...src.matchAll(/const (\w+)_TOOL_IDS = new Set\(\[([\s\S]*?)\]\)/g)].map((m) => ({
      family: m[1],
      names: [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]),
    }));
    expect(families.length).toBeGreaterThan(5);
    expect(families.filter((f) => !f.names.some((name) => toolNames.has(name))).map((f) => f.family)).toEqual([]);
    for (const name of ["apply_patch", "TaskCreate", "TaskUpdate", "TaskList", "SendMessage", "TeamCreate", "Skill", "StructuredOutput"]) {
      expect(toolNames.has(name), name).toBe(true);
    }
  });

  test("runs a cast command of every card", () => {
    const src = read("web/components/conversation/blocks/castBlocks.tsx");
    const config = src.slice(src.indexOf("const getCategoryConfig"), src.indexOf("const config = getCategoryConfig()"));
    const cardCategories = [...config.matchAll(/case "(\w+)":/g)].map((m) => m[1]);
    expect(cardCategories.length).toBeGreaterThan(5);
    const ran = new Set(casts.map((c) => normalizeCastCategory(c!.category)));
    // diff, summary, handoff, context and ask share one card; one of them covers it.
    const shared = new Set(["summary", "handoff", "context", "ask"]);
    expect(cardCategories.filter((c) => !shared.has(c) && !ran.has(c))).toEqual([]);
    // The dedicated cards: a session addressed by send/read, chat, decide, state.
    for (const c of ["send", "read", "chat", "decide", "state"]) expect(ran.has(c), c).toBe(true);
  });

  test("shows every system subtype either app draws", () => {
    const subtypes = new Set(rows.map((r) => r.subtype).filter(Boolean));
    const web = read("web/components/conversation/blocks/systemBlocks.tsx");
    const mobile = read("mobile/app/session/[id].tsx");
    const named = new Set([
      ...[...web.matchAll(/subtype === "(\w+)"/g)].map((m) => m[1]),
      ...[...mobile.matchAll(/message\.subtype === '(\w+)'/g)].map((m) => m[1]),
    ]);
    if (/subtype === CLOUD_AGENT_ACTION_SUBTYPE/.test(web)) named.add(CLOUD_AGENT_ACTION_SUBTYPE);
    expect([...named].filter((s) => !subtypes.has(s))).toEqual([]);
  });

  test("shows every kind of failure banner", () => {
    const types = read("web/components/conversation/types.ts");
    const block = types.slice(types.indexOf("export type ParsedApiError"), types.indexOf("};", types.indexOf("export type ParsedApiError")));
    const flags = [...block.matchAll(/^\s*(is\w+)\?: boolean/gm)].map((m) => m[1]);
    const parsed = assistantText.map((c) => parseApiErrorContent(c)).filter((e) => !!e) as any[];
    expect(flags.length).toBeGreaterThan(5);
    expect(flags.filter((f) => !parsed.some((e) => e[f]))).toEqual([]);
    expect(parsed.some((e) => e.statusCode >= 500)).toBe(true);
  });
});
