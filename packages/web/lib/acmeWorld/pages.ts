// Acme's published pages (cast publish), the rows artifacts.listForWeb sends
// the Pages list: the webhook retry report Alex's lead session published,
// Maya's retry dashboard, Sarah's mockup and a few more. Mobile's Metro
// reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { DAY, HOUR, MIN, PEOPLE, SESSIONS, WORKSPACE, cid, session, type Person } from "./world";

export const REPORT_SLUG = "acme-webhook-retry-failures";

type PageSeed = { slug: string; title: string; who: Person; ago: number; version: number; views: number; comments: number; kind?: string; session?: string; password?: boolean; expires?: number };

const SEEDS: PageSeed[] = [
  { slug: REPORT_SLUG, title: "Webhook retry failures, last 7 days", who: PEOPLE.me, ago: 14 * MIN, version: 3, views: 42, comments: 2, session: SESSIONS.lead.short_id },
  { slug: "acme-retry-dashboard", title: "Retry queue dashboard", who: PEOPLE.maya, ago: 2 * HOUR, version: 5, views: 118, comments: 1, session: "jx7r4dl" },
  { slug: "acme-retry-history-mock", title: "Attempt history mockup", who: PEOPLE.sarah, ago: 5 * HOUR, version: 2, views: 23, comments: 3, session: "jx7s1hm" },
  { slug: "acme-backoff-compare", title: "Backoff strategies compared", who: PEOPLE.maya, ago: 2 * DAY, version: 1, views: 61, comments: 0, session: "jx7p2mb" },
  { slug: "acme-stripe-v14-diff", title: "Stripe v14 call site diff", who: PEOPLE.me, ago: 30 * MIN, version: 2, views: 9, comments: 0, session: SESSIONS.stripe.short_id, password: true },
  { slug: "acme-ledger-incident", title: "Ledger restart incident review", who: PEOPLE.sarah, ago: 3 * DAY, version: 4, views: 87, comments: 0, kind: "markdown", expires: 27 * DAY },
];

export const PAGES = (now: number) =>
  SEEDS.map((p) => {
    const mine = p.who._id === PEOPLE.me._id;
    const url = `https://codecast.sh/a/${p.slug}`;
    return {
      slug: p.slug,
      title: p.title,
      source_path: `${p.slug}.html`,
      size: 48_000,
      version: p.version,
      kind: p.kind ?? "html",
      session_short_id: p.session ?? null,
      task_id: null,
      plan_id: null,
      station: null,
      created_at: now - p.ago - p.version * HOUR,
      updated_at: now - p.ago,
      url,
      manage_url: mine ? `${url}#o=acme-owner-key` : null,
      edit_url: null,
      team_only: false,
      has_password: !!p.password,
      email_gate: false,
      expires_at: p.expires ? now + p.expires : null,
      edit_mode: "owner",
      show_session: true,
      comments_enabled: true,
      mine,
      workspace: WORKSPACE,
      author_id: p.who._id,
      author: { name: p.who.name, image: p.who.image },
      can_team_edit: false,
      team_gate: null,
      has_thumb: false,
      views: p.views,
      last_viewed_at: now - p.ago / 2,
      comments_open: p.comments,
    };
  });

/** The session that published the report, with the page's link alone on a line of its reply: the app embeds it.
 *  Filed out of the inbox (dismissed), so the inbox shots are unchanged. */
export const REPORT_SESSION = { _id: cid("rptfailures"), short_id: "jx7m8rp", title: "Failure report for support", agent_type: "claude_code" };

const REPORT_TRANSCRIPT = (now: number) => [
  { _id: "hero-rpt-m1", role: "user", content: "Make a page with last week's webhook retry failures that support can read.", timestamp: now - 16 * MIN },
  {
    _id: "hero-rpt-m2",
    role: "assistant",
    content: "Pulling last week's failed deliveries and building the report.",
    tool_calls: [{ id: "hero-rpt-tc1", name: "Bash", input: JSON.stringify({ command: "cast publish report.html", description: "Publish the report" }) }],
    tool_results: [{ tool_use_id: "hero-rpt-tc1", content: `Published v3: https://codecast.sh/a/${REPORT_SLUG}` }],
    timestamp: now - 15 * MIN,
  },
  {
    _id: "hero-rpt-m3",
    role: "assistant",
    content: `The report is up:\n\nhttps://codecast.sh/a/${REPORT_SLUG}\n\nMost failures cluster around the 02:00 ledger restart, and 96% of them landed on a retry.`,
    timestamp: now - 14 * MIN,
  },
];

const reportRow = (now: number) =>
  session(now, REPORT_SESSION, { ago: 14 * MIN, waiting: "done", project: "~/src/billing", messages: 3, extra: { inbox_dismissed_at: now - 10 * MIN } });

export const PAGES_PART: AcmePart = {
  name: "pages",
  sessions: (now) => [reportRow(now)],
  seed: (s, now) => {
    s.applyTailMessages(REPORT_SESSION._id, 0, REPORT_TRANSCRIPT(now) as any, null);
  },
  answers: {
    "artifacts:listForWeb": () => ({ artifacts: PAGES(Date.now()) }),
    // What an embed needs to frame a page (artifacts.embedInfo): open pages only, so no gate tokens.
    "artifacts:embedInfo": (a) =>
      (a?.pages ?? []).map((p: { slug: string }) => {
        const page = PAGES(Date.now()).find((x) => x.slug === p.slug);
        return page ? { slug: page.slug, title: page.title, version: page.version, kind: page.kind, gated: false, thumb: false } : { slug: p.slug, missing: true };
      }),
  },
};
