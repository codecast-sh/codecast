import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { codeLines, walkSources } from "./sourceWalk";

// FAST REFRESH BOUNDARY GUARD.
//
// React Fast Refresh can hot-swap a module only if every export is a component
// (or an unchanged primitive). A helper function, hook, context or config object
// exported next to a component makes the whole file a failed boundary: on every
// save Vite invalidates it and re-executes its IMPORTERS instead — for a file
// under DashboardLayout that means the entire shell re-renders and re-runs its
// effects, which is the "dialogs flicker in dev" symptom with ten agents saving
// files in the shared tree. Move helpers to lib/ or hooks/ and import them.
//
// The heuristic mirrors @vitejs/plugin-react's isLikelyComponentType: an
// exported function/const is a component when its name starts uppercase and it
// is not obviously data (object/array/regex/new/createContext). Hooks (`useX`)
// and lowercase functions are helpers. Type-only exports are ignored.
//
// ALLOWED is a ratchet of the offenders that predate this rule. Fix one and its
// entry must go; a new offender fails here. Do not widen the list for new code.
//
// The second guard is the other way to lose a boundary: calling a component as
// a plain function (`const el = Inner(props, ref)`) instead of rendering it.
// Its hooks then run on the CALLER's fiber, and Fast Refresh signs the caller,
// whose own hook list never changes, so an edit that adds a hook to the callee
// keeps the fiber and crashes on the shifted slot ("Should have a queue",
// ConversationView 2026-09-03). Render it as an element; if the point was to
// time or size its output, measure inside its body.

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = ["app", "components"];

const ALLOWED = new Set<string>([
  "app/(marketing)/blog/blogChrome.tsx",
  "app/admin/daemon-logs/page.tsx",
  "app/calls/[id]/page.tsx",
  "app/config/page.tsx",
  "components/ActivityCharts.tsx",
  "components/ActivityHeatmap.tsx",
  "components/AgentTypeIcon.tsx",
  "components/BranchSelector.tsx",
  "components/BrowserHandoffToast.tsx",
  "components/CodeBlock.tsx",
  "components/CollapsibleBody.tsx",
  "components/CreateChannelModal.tsx",
  "components/DeviceBadge.tsx",
  "components/DiffView.tsx",
  "components/EdgePeek.tsx",
  "components/FormattedSummary.tsx",
  "components/GlobalSearch.tsx",
  "components/HtmlSnippet.tsx",
  "components/ImageGallery.tsx",
  "components/InlineDiff.tsx",
  "components/OwnersBadge.tsx",
  "components/PermissionCard.tsx",
  "components/SessionConstellation.tsx",
  "components/SyncStatusChip.tsx",
  "components/TaskStatusBadge.tsx",
  "components/TeamIcon.tsx",
  "components/ThemeProvider.tsx",
  "components/TriggerRunHistory.tsx",
  "components/browser/BrowserWatchSplit.tsx",
  "components/chat/ChatMessage.tsx",
  "components/chat/ChatToast.tsx",
  "components/editor/SlashCommand.tsx",
  // Deliberate data module: the message markdown pipeline (arrays/objects
  // by design). Its two importers re-execute on edit, and that is the point —
  // it keeps those exports out of ConversationView.
  "components/messageMarkdown.tsx",
  "components/ui/badge.tsx",
  "components/ui/button.tsx",
  "components/ui/context-menu.tsx",
  "components/vault/VaultExplorer.tsx",
  "components/vault/VaultHoverPreview.tsx",
  "components/vault/VaultMarkdown.tsx",
  "components/vault/VaultNoteView.tsx",
  "components/vault/useVaultLinkCtx.tsx",
  // Pinned 2026-10-15: offenders that landed Oct 1 to 15 while test-web was red,
  // so this ratchet could not stop them. Same rule as above: fix one, drop it here.
  "app/(marketing)/blog/field-manual/markdown.tsx",
  "app/(marketing)/blog/field-manual/parts.tsx",
  "app/(marketing)/blog/figureKit.tsx",
  "app/(marketing)/features/agents/parts.tsx",
  "app/(marketing)/features/browser/Checkout.tsx",
  "app/(marketing)/features/browser/ChromeWindow.tsx",
  "app/(marketing)/features/browser/kit.tsx",
  "app/(marketing)/features/cloud/kit.tsx",
  "app/(marketing)/features/computer/parts.tsx",
  "app/(marketing)/features/decisions/kit.tsx",
  "app/(marketing)/features/decisions/mocks.tsx",
  "app/(marketing)/features/kit.tsx",
  "app/(marketing)/features/memory/kit.tsx",
  "app/(marketing)/features/pages.tsx",
  "app/(marketing)/features/publish/kit.tsx",
  "app/(marketing)/features/pull-requests/kit.tsx",
  "app/(marketing)/features/triggers/ui.tsx",
  "app/connect/whisk/page.tsx",
  "app/meet/[token]/GuestLobby.tsx",
  "app/meet/[token]/GuestOutcome.tsx",
  "app/meet/[token]/MeetChrome.tsx",
  "app/share/SharedObjectPage.tsx",
  "app/share/decision/DecisionView.tsx",
  "app/tasks/page.tsx",
  "app/welcome/EmailStep.tsx",
  "components/CloudPlacementStrip.tsx",
  "components/ComposeRolePicker.tsx",
  "components/ContextRail.tsx",
  "components/CreateDialog.tsx",
  "components/FileDiffLayout.tsx",
  "components/HeightGrip.tsx",
  "components/ModelEffortPicker.tsx",
  "components/PlanGraphView.tsx",
  "components/ProfileSignInDialog.tsx",
  "components/PublishedPageEmbed.tsx",
  "components/RoutePane.tsx",
  "components/agentFeatures/FeatureDetail.tsx",
  "components/agentFeatures/FeatureVignette.tsx",
  "components/calls/CallTasks.tsx",
  "components/calls/MeetingOfferToast.tsx",
  "components/calls/RecordingMark.tsx",
  "components/calls/RoomRecording.tsx",
  "components/changes/EvidenceDrawer.tsx",
  "components/changes/StoryParts.tsx",
  "components/changes/useChangesKeys.tsx",
  "components/cloudAgents/index.tsx",
  "components/comments/AnchorPlacementNote.tsx",
  "components/conversation/HostedApprovalCard.tsx",
  "components/conversation/HostedConnection.tsx",
  "components/conversation/HostedMadeLine.tsx",
  "components/conversation/HostedNotice.tsx",
  "components/conversation/HostedStatusLine.tsx",
  "components/conversation/RunLogEndedBar.tsx",
  "components/decisions/ChangeCardDecision.tsx",
  "components/decisions/ChangeCardView.tsx",
  "components/decisions/DecisionAnswering.tsx",
  "components/decisions/DecisionSections.tsx",
  "components/decisions/StackPolicy.tsx",
  "components/diff/PierreDiff.tsx",
  "components/docs/drafting/DraftingUI.tsx",
  "components/evals/GuardLog.tsx",
  "components/evals/RunFiles.tsx",
  "components/evals/host.tsx",
  "components/evals/runPanels.tsx",
  "components/evals/wallSim.tsx",
  "components/graph/LinkGraphCanvas.tsx",
  "components/history/HistoryRail.tsx",
  "components/inbox/SessionCard.tsx",
  "components/initiatives/InitiativeAtoms.tsx",
  "components/initiatives/IntentHeader.tsx",
  "components/line/RunReport.tsx",
  "components/line/map/LineStartSwitch.tsx",
  "components/line/map/useSendThroughLine.tsx",
  "components/line/settings/LineSettingsStage.tsx",
  "components/line/settings/LineStations.tsx",
  "components/line/widgets/BeforeAfterTable.tsx",
  "components/line/widgets/ChangeCode.tsx",
  "components/line/widgets/ClosedDecisionActs.tsx",
  "components/line/widgets/FindingReader.tsx",
  "components/line/widgets/LineFence.tsx",
  "components/line/widgets/MomentView.tsx",
  "components/line/widgets/ProductView.tsx",
  "components/line/widgets/ProductViewLink.tsx",
  "components/line/widgets/TrialEvidenceBand.tsx",
  "components/line/widgets/actionSlots.tsx",
  "components/line/widgets/parts.tsx",
  "components/line/workspace/StartSessionButton.tsx",
  "components/line/workspace/stages/LineDrawer.tsx",
  "components/line/workspace/step/StepInstructions.tsx",
  "components/line/workspace/views/ProblemPointers.tsx",
  "components/line/workspace/views/finder/FindTable.tsx",
  "components/line/workspace/views/graph/GraphCanvas.tsx",
  "components/line/workspace/views/problem/AskBlock.tsx",
  "components/line/workspace/views/run/RunStep.tsx",
  "components/line/workspace/views/timeline/ProblemsTrend.tsx",
  "components/line/workspace/views/timeline/TimelineChart.tsx",
  "components/memory/MemoryEditor.tsx",
  "components/mods/ModTree.tsx",
  "components/ops/ReplayImport.tsx",
  "components/ops/ReplayMomentEmbed.tsx",
  "components/ops/parts.tsx",
  "components/org/GoalsNodeCards.tsx",
  "components/org/OrgChart.tsx",
  "components/org/OrgFlowEdges.tsx",
  "components/org/ProposalLedger.tsx",
  "components/org/ProposalSubjectCard.tsx",
  "components/org/RecordGroupRow.tsx",
  "components/org/StagedBand.tsx",
  "components/org/orgFlowViz.tsx",
  "components/org/scope/RoleHandoffSections.tsx",
  "components/org/scope/RoleOffer.tsx",
  "components/org/useOrgMoves.tsx",
  "components/org/useOrgPeopleView.tsx",
  "components/resources/ResourcePressureGauge.tsx",
  "components/sessionMap/MapCard.tsx",
  "components/settings/AddCloudHost.tsx",
  "components/settings/CloudAutoscale.tsx",
  "components/sidebar/SidebarNav.tsx",
  "components/simple/WhiskWordmark.tsx",
  "components/simple/useHostedAskGate.tsx",
  "components/tasks/TaskBlockedMark.tsx",
  "components/tasks/TaskRelations.tsx",
  "components/team/TeamFindableNudge.tsx",
  "components/trial/TrialCardBody.tsx",
  "components/trial/TrialFactsStrip.tsx",
  "components/trial/TrialReviewPage.tsx",
  "components/trial/TrialStopActs.tsx",
]);

const walk = (dir: string) => walkSources(dir).filter((f) => f.endsWith(".tsx"));

// `Inner(props, ref)` / `Inner(props)`: a PascalCase identifier invoked with
// `props` as its first argument. Declarations (`function Inner(props`) carry
// the `function` keyword and are skipped; annotations (`props:`) never match.
const PLAIN_COMPONENT_CALL = /(?:^|[^\w$.])([A-Z][\w$]*)\(\s*props\s*[,)]/;

/** Lines that invoke a component as a plain function instead of rendering it. */
export function plainComponentCalls(source: string): string[] {
  const out: string[] = [];
  for (const { line, n } of codeLines(source)) {
    if (/\bfunction\s+[A-Z]/.test(line)) continue;
    const m = PLAIN_COMPONENT_CALL.exec(line);
    if (m) out.push(`${n}: ${m[1]}(props…)`);
  }
  return out;
}

const COMPONENT_LIKE_INIT = /^(memo|forwardRef|React\.memo|React\.forwardRef|lazy|dynamic|styled|\(|function|async|[A-Za-z_$][\w$]*\s*=>)/;

/** Exports that would make Fast Refresh reject the module. */
export function nonComponentExports(source: string): string[] {
  const bad: string[] = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!/^[A-Z]/.test(m[1])) bad.push(`${m[1]}()`);
  }
  for (const m of source.matchAll(/^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=\s*([^\n]{0,80})/gm)) {
    const [, name, init] = m;
    const value = init.trim();
    if (!/^[A-Z]/.test(name)) { bad.push(name); continue; }
    if (!COMPONENT_LIKE_INIT.test(value)) bad.push(name);
  }
  for (const m of source.matchAll(/^export\s+(?:enum|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    // Classes remount on refresh anyway; only enums are data here.
    if (m[0].startsWith("export enum")) bad.push(m[1]);
  }
  for (const m of source.matchAll(/^export\s+\{([^}]+)\}/gm)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p || p.startsWith("type ")) continue;
      const local = p.split(/\s+as\s+/).pop()!.trim();
      // Re-exports of a component name are fine; a lowercase name is a helper.
      if (!/^[A-Z]/.test(local)) bad.push(`{${local}}`);
    }
  }
  return bad;
}

describe("component modules export only components (Fast Refresh boundaries)", () => {
  const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
  const offenders = new Map<string, string[]>();
  for (const f of files) {
    const bad = nonComponentExports(readFileSync(f, "utf8"));
    if (bad.length) offenders.set(relative(ROOT, f), bad);
  }

  test("no new component module exports helpers, hooks or config objects", () => {
    const fresh = [...offenders].filter(([f]) => !ALLOWED.has(f));
    const msg = fresh.map(([f, bad]) => `  ${f}: ${bad.join(", ")}`).join("\n");
    expect(fresh, `Move these out to lib/ or hooks/ (see header):\n${msg}`).toEqual([]);
  });

  test("shared markdown and entity renderers remain Fast Refresh boundaries", () => {
    for (const file of [
      "components/tools/MarkdownRenderer.tsx",
      "components/tools/MarkdownImages.tsx",
      "components/EntityIdPill.tsx",
      "components/EntityObjectCard.tsx",
    ]) {
      expect(nonComponentExports(readFileSync(join(ROOT, file), "utf8")), file).toEqual([]);
    }
  });

  test("the allowlist only names files that still offend (ratchet)", () => {
    const stale = [...ALLOWED].filter((f) => !offenders.has(f));
    expect(stale, "These files are clean now — remove them from ALLOWED").toEqual([]);
  });

  test("no component invokes another component as a plain function", () => {
    const calls = files
      .map((f) => [relative(ROOT, f), plainComponentCalls(readFileSync(f, "utf8"))] as const)
      .filter(([, bad]) => bad.length);
    const msg = calls.map(([f, bad]) => `  ${f}: ${bad.join(", ")}`).join("\n");
    expect(calls, `Render these as elements instead of calling them (see header):\n${msg}`).toEqual([]);
  });
});
