import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityType } from "@codecast/shared/entities";

// Every page about one thing has its own address and a Share button in its
// header (AGENTS.md, UI conventions). This map names, for every entity type,
// the file that draws its page header; each must render a share control. A new
// entity type is a compile error here until it names its page, or says why it
// has none.
const ROOT = join(import.meta.dir, "..", "..");

type Page = string[] | { none: string };

const ENTITY_PAGES: Record<EntityType, Page> = {
  // The task page draws its header (both styles) in its sibling TaskHead.tsx.
  task: ["app/tasks/[id]/TaskHead.tsx"],
  plan: ["app/plans/[id]/page.tsx"],
  session: ["app/inbox/QueuePageClient.tsx", "components/GlobalSessionPanel.tsx", "app/conversation/[id]/diff/page.tsx"],
  doc: ["app/docs/[id]/page.tsx"],
  project: ["app/projects/[id]/page.tsx"],
  initiative: ["components/org/company/SheetFrame.tsx"],
  proposal: ["components/org/OrgPanel.tsx"],
  trigger: ["app/triggers/[id]/page.tsx"],
  decision: ["components/decisions/DecisionDocument.tsx", "components/SessionDecisionCard.tsx"],
  pr: ["components/pr/PRActions.tsx"],
  commit: ["app/commit/[owner]/[repo]/[sha]/page.tsx"],
  call: ["app/calls/page.tsx"],
  source: { none: "a source opens the Ops timeline filtered to it (/ops?source=src-N), a list view, not a page of its own" },
  replay: ["components/ops/ReplayIssues.tsx", "components/ops/ReplayPlayer.tsx"],
  // A role's page is its standing conversation.
  role: ["app/inbox/QueuePageClient.tsx"],
  person: ["app/team/[username]/page.tsx"],
  deploy: ["components/deploys/DeploysPage.tsx"],
  secret: ["components/secrets/SecretDetail.tsx"],
  flow: ["components/line/workspace/LineWorkspace.tsx"],
};

// Object pages that are not entity types of their own.
const OTHER_PAGES = [
  "app/workflows/runs/[id]/page.tsx",
  "components/decisions/StackPage.tsx",
  "components/ops/IssuePage.tsx",
  "components/ops/MetricPage.tsx",
  "components/mods/ObjectPage.tsx",
  "components/mods/ModPanePage.tsx",
  "components/repo/RepoChrome.tsx",
  "components/repo/BlobContent.tsx",
];

const SHARE = /<(ShareControl|ConversationSharePopover|SharePopover|ShareMoment|CodeShareMenu|CodeShareItems)\b/;

describe("every object page carries a Share button", () => {
  const files = [...new Set([...Object.values(ENTITY_PAGES).flatMap((p) => (Array.isArray(p) ? p : [])), ...OTHER_PAGES])];
  test.each(files)("%s renders a share control", (rel) => {
    expect(SHARE.test(readFileSync(join(ROOT, rel), "utf8"))).toBe(true);
  });
});
