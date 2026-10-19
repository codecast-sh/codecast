// Types only, so a reader of message types (the phone included) does not pull
// the external-event presentation code into its program.

/** An external_events row as it arrives from convex. Fields are all optional
 *  here because the row is server data a client of any age may hold. */
export type ExternalEventRecord = {
  _id: string;
  team_id?: string;
  source?: string;
  repository?: string;
  kind?: string;
  actor_login?: string;
  actor_avatar_url?: string;
  actor_user_id?: string;
  title?: string;
  summary?: string;
  url?: string;
  sha?: string;
  branch?: string;
  pr_id?: string;
  pr_number?: number;
  commit_id?: string;
  comment_id?: string;
  issue?: { provider?: string; key?: string; url?: string; title?: string };
  conversation_id?: string;
  task_id?: string;
  task_short_id?: string;
  task_ids?: string[];
  plan_ids?: string[];
  project_ids?: string[];
  meta?: Record<string, string | number | undefined>;
  // An ingestion transition (external-data.md X3): the group it moved and
  // the source that saw it.
  source_id?: string;
  group_id?: string;
  data?: { group_short_id?: string; source_name?: string; release?: string; environment?: string; count?: number; level?: string };
  dedupe_key?: string;
  created_at?: number;
};
