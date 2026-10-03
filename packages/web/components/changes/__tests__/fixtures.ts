// Store-shaped rows for the Changes page tests: a story and an edition with
// every field the page reads, overridable per case.
import type { EditionRow, LiveRow, StoryRow } from "../../../hooks/useSyncChanges";

const DAY = "2026-10-02";
const at = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00Z`);

export function story(key: string, over: Partial<StoryRow> = {}): StoryRow {
  return {
    _id: `id_${key}` as any,
    _creationTime: 0,
    team_id: "team1" as any,
    repository: "codecast-sh/codecast",
    date: DAY,
    story_key: key,
    area: "web",
    branch: "main",
    on_default_branch: true,
    commit_shas: [`sha_${key}`],
    conversation_ids: [],
    pr_ids: [],
    author_names: ["Ada"],
    actor_user_ids: [],
    insertions: 10,
    deletions: 2,
    files_changed: 1,
    area_counts: { web: 1 },
    risks: [],
    first_at: at("10:00"),
    last_at: at("10:00"),
    headline: `Headline ${key}`,
    dek: `Dek ${key}`,
    kind: "feature",
    importance: 2,
    prose_status: "pending",
    private_session_count: 0,
    ...over,
  } as StoryRow;
}

export function edition(over: Partial<EditionRow> = {}): EditionRow {
  return {
    _id: "ed1" as any,
    _creationTime: 0,
    team_id: "team1" as any,
    scope: "day",
    date: DAY,
    narrative: "",
    generated_at: at("16:08"),
    repository: "codecast-sh/codecast",
    status: "facts",
    dirty_since: null,
    stale: false,
    ...over,
  } as EditionRow;
}

export function liveRow(surface: string, over: Partial<LiveRow> = {}): LiveRow {
  return {
    _id: `team1|codecast-sh/codecast|${surface}`,
    team_id: "team1" as any,
    repository: "codecast-sh/codecast",
    surface,
    sha: `ship_${surface}`,
    at: at("15:27"),
    kind: "release",
    waiting: 0,
    waiting_exact: true,
    ...over,
  };
}

export { DAY, at };
