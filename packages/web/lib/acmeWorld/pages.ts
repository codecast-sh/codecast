// Acme's published pages (cast publish), the rows artifacts.listForWeb sends
// the Pages list: the webhook retry report Alex's lead session published,
// Maya's retry dashboard, Sarah's mockup and a few more. Mobile's Metro
// reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { DAY, HOUR, MIN, PEOPLE, SESSIONS, WORKSPACE, type Person } from "./world";

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

export const PAGES_PART: AcmePart = {
  name: "pages",
  answers: { "artifacts:listForWeb": () => ({ artifacts: PAGES(Date.now()) }) },
};
