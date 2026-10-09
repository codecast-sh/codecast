"use client";
// /org, /org/<ref>, /org/goals and /org/projects: the Org screen (essence
// spec §3, §5). One surface (the canvas, or one of the two read views) and
// one resizable panel beside it holding whatever the address names: a goal,
// project, role or person (`/org/<ref>`), a conversation (`?session=`) or a
// proposal (`?proposal=`). The address is the only durable state: each open
// pushes history, so the browser's Back returns to the previous object, and
// closing pushes the view itself. Esc closes. Above 900px the panel sits
// beside the surface and never covers it; below, an open panel takes the
// content area with "← Org" in its bar.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Group, Panel, Separator } from "react-resizable-panels";
import { create as mutate } from "mutative";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { OrgObjectKind } from "@codecast/shared/entities";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { useFoldingSplit } from "../../hooks/useFoldingSplit";
import { useMeasuredWidth } from "../../hooks/useMeasuredWidth";
import { defaultNewSessionPath, useInboxStore, useTrackedStore, type ProjectItem } from "../../store/inboxStore";
import { createOrgSlice } from "../../store/orgSlice";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncOrgProposal, useSyncOrgProposals } from "../../hooks/useSyncOrgProposals";
import { useSwitchWorkspace } from "../../hooks/useSwitchWorkspace";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useOrgFeatureOn } from "../../hooks/useOrgFeatureOn";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { isConvexId } from "../../lib/entityLinks";
import { workspaceDisplayName } from "../../lib/workspaceScope";
import { markOrgIntroSeen, markOrgUpsellSeen } from "../../lib/orgIntro";
import { proposalAnswersOf } from "../../lib/reviewActions";
import { orgObjectTarget, orgRefNeedsTypeLookup } from "../../lib/orgObjectTarget";
import { cn } from "../../lib/utils";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { CompanyDocument } from "../company/CompanyDocument";
import { OrgHeader } from "./OrgHeader";
import { PREVIEW_BATCH } from "./OrgConversation";
import { OrgDetailPanel, type LinkLineState } from "./OrgDetailPanel";
import { OrgPreviewBanner, OrgReadStateBlock, OrgStaleBanner, type OrgReadBlockKind } from "./OrgReadStateBlock";
import { OrgHistorySheet } from "./OrgHistorySheet";
import { OrgIntro } from "./OrgIntro";
import { HeadSeatDialog, type HeadSeatChoice } from "./HeadSeatDialog";
import { OrgProposalFeeders } from "./OrgProposalFeeders";
import { peopleOnlyTree, type RosterRow } from "./orgPeopleTree";
import { orgTreeReadState } from "./orgReadState";
import { activeOrgWorkspace } from "./useNeedsYou";
import { findHeadOfPeople, inWorkspace, isDecidable, orgPreviewEnabled, pickProposal, resolveProposalLink } from "./staffingModel";
import { detailLayout, detailSizeOf, openProposalsToFeed, orgScreenParams, ORG_CANVAS_ID, ORG_CANVAS_MIN_PX, ORG_DETAIL_DEFAULT, ORG_DETAIL_ID, ORG_DETAIL_MIN_PX, ORG_PANEL_FILLS_BELOW } from "./orgScreenModel";
import { canonicalRef, seatFor } from "./company/objects";
import { sheetId, sheetKey, type SheetRef } from "./company/sheetStack";
import { SheetHostContext, type SheetHost } from "./company/sheetHost";
import { OrgOpenContext, type OrgOpen } from "./company/orgOpenContext";
import { CompanyRowsOverride, useCompanyRows, type CompanyRows } from "./company/useCompanyRows";
import { orgAddressOf, orgObjectPath, panelHref, panelKey, panelOfAddress, panelRefOf, type DecisionAt, type PanelRef } from "./panelTarget";
import { GOALS_FIXTURE_DATA, GOALS_FIXTURE_PROJECTS, ORG_GOALS_FIXTURE_PROPOSAL } from "./goalsFixture";
import { ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL } from "./orgStaffingFixture";
import { readOrgPreviewSpec, readOrgPreviewTree } from "./orgPreviewSpec";
import { ORG_FIXTURE_WITH_HEAD } from "./orgFixture";
import { joinProposals, type OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";
import type { OrgResetPreview } from "./orgMeta";
import "./company/company.css";

/** The DEV preview flag is read from the live URL on every render (see
 *  orgPreviewEnabled): a module constant survived in-app navigation and kept
 *  painting fixtures on a workspace with no tree after the flag was gone. */
const ORG_PREVIEW_DEV = !!import.meta.env.DEV;

/** How long the split is marked as moving after an open or a close (company.css animates 180ms). */
const SPLIT_MOVE_MS = 220;

const round = (n: number) => Math.round(n * 100) / 100;

export function OrgScreen() {
  const { tree: storeTree, ready, missing, refused, error: treeError, retry: retryTree } = useSyncOrgTree();
  useSyncOrgProposals();
  // Proposals are two collections (list rows, and the changes of fed
  // proposals) joined at render.
  const s = useTrackedStore([
    (st) => st.currentUser?._id,
    (st) => st.clientState.ui?.active_team_id,
    (st) => st.orgProposals,
    (st) => st.orgProposalChanges,
    (st) => st.orgIntentNotice?.at,
    (st) => st.teams,
    (st) => st.clientState.ui?.org_intro_seen,
    (st) => st.clientStateInitialized,
  ]);
  // The journal put an edit back on its own (no echo within its TTL): say
  // so, because a paused badge that quietly reappears reads as a bug. A
  // refusal toasts from the dispatch hook; this is the silent case.
  const intentNotice = s.orgIntentNotice;
  useWatchEffect(() => {
    if (intentNotice) toast.error(intentNotice.text);
  }, [intentNotice?.at]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const params = useMemo(() => orgScreenParams(search), [search]);

  // -------- the address: the view, and the object its path names
  // A short ref names its kind; an older form (a goal's stub key, a bare
  // Convex id) is named by the store, else by the server.
  const { view, ref: routeId } = orgAddressOf((useParams() ?? {}) as { view?: string; id?: string });
  const needsLookup = useInboxStore((st) => (routeId ? orgRefNeedsTypeLookup(routeId, st) : false));
  const { data: resolvedType, error: resolveError } = useQueryNoThrow(_api.entities.resolveIdType as any, needsLookup && routeId ? { id: routeId } : "skip");
  // One string, so the subscription wakes only when the answer changes.
  const routeKey = useInboxStore((st) => {
    if (!routeId) return "";
    const t = orgObjectTarget(routeId, st, resolveError ? null : (resolvedType as any));
    return t.kind === "pending" ? "pending" : t.kind === "scope" ? "" : `${t.kind}:${t.ref}`;
  });
  const routeSheet = useMemo<SheetRef | null>(() => {
    if (!routeKey || routeKey === "pending") return null;
    const at = routeKey.indexOf(":");
    return { kind: routeKey.slice(0, at) as OrgObjectKind, ref: routeKey.slice(at + 1) };
  }, [routeKey]);
  // An object whose ref was renamed (a stub goal's key once the server minted
  // its `in-N`) keeps the identity it was opened under, so its sheet stays
  // mounted, its typed name kept, under the new address.
  const [identity, setIdentity] = useState<{ key: string; id: string } | null>(null);
  const object = useMemo<SheetRef | null>(() => (routeSheet && identity?.key === sheetKey(routeSheet) ? { ...routeSheet, id: identity.id } : routeSheet), [routeSheet, identity]);
  // How a panel was opened, held for this visit: a project to pick its lead,
  // a conversation at the decision it asks. Neither belongs in the address.
  const [opened, setOpened] = useState<{ key: string; intent?: "pick-lead"; decision?: DecisionAt } | null>(null);
  const addressPanel = useMemo(() => panelOfAddress(object, params), [object, params]);
  const panel = useMemo<PanelRef | null>(() => {
    if (!addressPanel || !opened || opened.key !== panelKey(addressPanel)) return addressPanel;
    if (addressPanel.kind === "session") return opened.decision ? { ...addressPanel, decision: opened.decision } : addressPanel;
    if (addressPanel.kind === "proposal") return addressPanel;
    return opened.intent ? { ...addressPanel, intent: opened.intent } : addressPanel;
  }, [addressPanel, opened]);

  const switchWorkspace = useSwitchWorkspace();
  const phone = useIsPhone();
  const { width, measureRef } = useMeasuredWidth();
  const fills = phone || (width ?? (typeof window !== "undefined" ? window.innerWidth : ORG_PANEL_FILLS_BELOW)) < ORG_PANEL_FILLS_BELOW;
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;
  const activeTeamId = s.clientState.ui?.active_team_id as string | undefined;

  // A client ahead of a backend deploy (CLAUDE.md: web ships on push, Convex
  // when a person runs deploy.sh) answers "Could not find public function".
  // That is an honest empty state, never invented people with real names.
  // The fixture is a DEV preview only (`?preview=1` in the live URL), for
  // design work offline; its edits apply to a local copy through the SAME
  // slice bodies the store uses. Never a fallback for missing data.
  const preview = orgPreviewEnabled(search, ORG_PREVIEW_DEV);
  const [previewTree, setPreviewTree] = useState<OrgTree>(() => readOrgPreviewTree() ?? ORG_FIXTURE_WITH_HEAD);
  // A dry run's spec in this tab's session storage paints ahead of the fixtures (org-eval.md).
  const [previewProposals, setPreviewProposals] = useState<OrgProposalRow[]>(() => { const spec = readOrgPreviewSpec(); return [...(spec ? [spec] : []), ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL, ORG_GOALS_FIXTURE_PROPOSAL]; });
  // The slot holds one tree. After a workspace switch it still holds the
  // previous workspace's until the new answer lands; a tree that names another
  // workspace is not this page's data, so paint the skeleton for that round
  // trip instead of a foreign org. Personal = the viewer's own user id.
  const wantedWorkspace = activeTeamId && isConvexId(activeTeamId) ? activeTeamId : meId;
  const treeMatches = !storeTree || !wantedWorkspace || storeTree.workspace.id === wantedWorkspace;
  // The org feature (D11) gates the agents half. With it off the server sends
  // no tree, and the company still shows: its people come from the roster the
  // store holds, with no roles.
  const orgOn = useOrgFeatureOn();
  const agentsOff = !orgOn && !preview;
  const roster = useInboxStore((st) => (agentsOff ? st.teamMembers : null)) as RosterRow[] | null;
  const meRow = useInboxStore((st) => (agentsOff ? st.currentUser : null)) as RosterRow | null;
  const peopleTree = useMemo(() => {
    if (!agentsOff || !wantedWorkspace) return null;
    const team = activeTeamId && isConvexId(activeTeamId) ? (s.teams as { _id: string; name?: string }[] | undefined)?.find((t) => String(t._id) === activeTeamId) : null;
    return peopleOnlyTree({ workspace: team ? { kind: "team", id: activeTeamId!, name: team.name ?? "Team" } : { kind: "user", id: wantedWorkspace, name: "Personal" }, roster: roster ?? [], me: meRow, now: Date.now() });
  }, [agentsOff, wantedWorkspace, activeTeamId, s.teams, roster, meRow]);
  const tree: OrgTree | null = preview ? previewTree : agentsOff ? peopleTree : treeMatches ? storeTree : null;

  // -------- proposals
  const proposals = useMemo<OrgProposalRow[]>(() => preview ? previewProposals : joinProposals(s.orgProposals, s.orgProposalChanges), [preview, previewProposals, s.orgProposals, s.orgProposalChanges]);
  // One workspace for every proposal read here, taken the way the sidebar's
  // count takes it (activeOrgWorkspace), so the two agree even while the tree
  // is loading, refused or still another workspace's.
  const proposalWorkspace = useMemo(() => preview ? previewTree.workspace : activeOrgWorkspace(activeTeamId, meId), [preview, previewTree, activeTeamId, meId]);
  const workspaceProposals = useMemo(() => proposals.filter((p) => inWorkspace(p, proposalWorkspace)), [proposals, proposalWorkspace]);
  const linkedRef = params.proposal;
  const linked = useMemo(() => pickProposal(workspaceProposals, linkedRef), [workspaceProposals, linkedRef]);
  // The linked proposal, whatever workspace it lives in: the get feeder fills
  // its row and changes, and the resolver names a foreign or unreadable link.
  const lookup = useSyncOrgProposal(preview ? null : linkedRef);
  const activeWorkspace = tree ? { kind: tree.workspace.kind, id: tree.workspace.id } : null;
  const linkState = useMemo(() => preview ? { kind: "open" as const } : resolveProposalLink(linkedRef, proposals, activeWorkspace, lookup), [preview, linkedRef, proposals, activeWorkspace?.kind, activeWorkspace?.id, lookup.ready, lookup.missing]); // eslint-disable-line react-hooks/exhaustive-deps
  const linkLine = useMemo<LinkLineState | null>(() => {
    if (linkState.kind === "open") return null;
    if (linkState.kind !== "foreign") return linkState;
    const ws = linkState.workspace;
    return { kind: "foreign", shortId: linkState.shortId, workspaceName: workspaceDisplayName(ws, s.teams, meId), teamId: ws.kind === "team" ? ws.id : null };
  }, [linkState, s.teams, meId]);
  const head = useMemo(() => findHeadOfPeople(tree), [tree]);
  const headConv = head?.standing?.conversation_id ? String(head.standing.conversation_id) : null;
  const feedRefs = useMemo(() => preview ? [] : openProposalsToFeed(workspaceProposals, linkedRef), [preview, workspaceProposals, linkedRef]);
  // What the screen says about the read itself (orgReadState.ts): a failure
  // or a refusal is said, never painted as an empty chart.
  const readState = useMemo(() => orgTreeReadState({ hasTree: !!tree, hasNodes: (tree?.roles.length ?? 0) + (tree?.people.length ?? 0) > 0, ready: ready || agentsOff, missing: missing && !agentsOff, refused: !preview && !agentsOff && refused, error: preview || agentsOff ? null : treeError }), [tree, ready, missing, refused, treeError, preview, agentsOff]);

  // `?proposal=op-N&focus=<n>` is the link of one change (`op-N#n`): the
  // cards light the subject holding it. Once per proposal and number, so a
  // person who then picks another entry is not pulled back; a number whose
  // row has not landed yet is tried again when the rows do.
  const focusApplied = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!linked || linked.short_id !== params.proposal || params.focus === null) return;
    const key = `${linked._id}#${params.focus}`;
    if (focusApplied.current === key) return;
    const change = linked.changes.find((c) => c.seq === params.focus && c.status !== "removed");
    if (!change) return;
    focusApplied.current = key;
    useInboxStore.getState().setOrgFocusChangeId(change._id);
  }, [linked?._id, linked?.changes, params.proposal, params.focus]);
  // Leaving the screen clears the focus; the once-guard goes with it, so a
  // remount (StrictMode's dev double mount included) applies the link again.
  useMountEffect(() => () => { focusApplied.current = null; useInboxStore.getState().setOrgFocusChangeId(null); });

  // -------- moving the panel: every open pushes history, a close pushes the view
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const open = useCallback((toArg: PanelRef | OrgObjectKind, ref?: string, opts?: { focus?: boolean }) => {
    const to = panelRefOf(toArg, ref);
    if (!to) return;
    const key = panelKey(to)!;
    const intent = to.kind !== "session" && to.kind !== "proposal" ? to.intent : undefined;
    const decision = to.kind === "session" ? to.decision : undefined;
    setOpened(intent || decision ? { key, intent, decision } : null);
    setFocusKey(opts?.focus && to.kind !== "session" && to.kind !== "proposal" ? sheetId(to) : null);
    const href = panelHref(view, to, search);
    if (href !== panelHref(view, addressPanel, search)) router.push(href);
  }, [view, search, router, addressPanel]);
  const close = useCallback(() => { if (addressPanel) router.push(panelHref(view, null, search)); }, [addressPanel, router, view, search]);
  const openProposal = useCallback((shortId: string, seq?: number) => open({ kind: "proposal", id: shortId, ...(seq !== undefined ? { seq } : {}) }), [open]);
  const orgOpen = useMemo<OrgOpen>(() => ({ open: (to, ref) => open(to, ref), openProposal }), [open, openProposal]);

  // Esc closes the panel, unless the key is a field's (a draft, a rename), a
  // region's that owns its keys, another pane's, or an open menu's or modal's.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || keyBelongsElsewhere(e.target)) return;
    const t = e.target as Element | null;
    if (t instanceof Element && t !== document.body && !t.closest("[data-org-screen]")) return;
    if (document.querySelector("[role=menu][data-state=open], [role=dialog][data-state=open], [role=alertdialog]")) return;
    e.preventDefault();
    close();
  }, addressPanel ? window : null);

  // `?compose=` seeds the Head of People's draft (a draft the person already
  // typed wins) and opens its conversation, where the embedded composer
  // reads the draft; the parameter leaves the address so a reload does not
  // seed it twice.
  useWatchEffect(() => {
    if (!params.compose || !headConv) return;
    const st = useInboxStore.getState();
    const existing = st.getDraft(headConv) ?? {};
    if (!existing.draft_message) st.setDraft(headConv, { ...existing, draft_message: params.compose });
    router.replace(panelHref(view, { kind: "session", id: headConv }, search));
  }, [params.compose, headConv]);
  // `?panel=history` (the undo timeline's "Open in org record") opens the history; the parameter then leaves the address.
  const [historyOpen, setHistoryOpen] = useState(false);
  useWatchEffect(() => {
    if (!params.history) return;
    setHistoryOpen(true);
    const q = new URLSearchParams(search);
    q.delete("panel");
    const rest = q.toString();
    const path = object ? orgObjectPath(view, object.kind, object.ref) : panelHref(view, null);
    router.replace(rest ? `${path}?${rest}` : path);
  }, [params.history]);

  // The preview's sheets read its fixture, the same rows its canvas draws.
  const liveCompany = useCompanyRows();
  const previewCompany = useMemo<CompanyRows | null>(() => (preview ? { goals: GOALS_FIXTURE_DATA.initiatives, projects: GOALS_FIXTURE_PROJECTS as unknown as ProjectItem[], tree, members: [] } : null), [preview, tree]);
  const company = previewCompany ?? liveCompany;
  const addressRows = useMemo(() => ({ ...company, tree }), [company, tree]);
  // An address in an older form (a goal's stub key, a Convex id, a person's
  // user id) moves to the object's short ref once the store names it, in
  // place: the object keeps its identity, so its sheet stays as it is.
  const canonical = object ? canonicalRef(object, addressRows) : null;
  useWatchEffect(() => {
    if (!object || !canonical || !routeId || canonical.toLowerCase() === routeId.replace(/^@/, "").toLowerCase()) return;
    const to = { kind: object.kind, ref: canonical };
    setIdentity({ key: sheetKey(to)!, id: sheetId(object) });
    router.replace(`${orgObjectPath(view, to.kind, to.ref)}${search ? `?${search}` : ""}`);
  }, [object?.kind, object?.ref, canonical, routeId]);

  const host = useMemo<SheetHost>(() => ({
    close,
    open: (to, ref) => open(to, ref),
    // Talk opens whoever answers for the object: a role is its own conversation.
    talk: (to) => {
      if (to.kind === "role") { open(to); return; }
      const seat = seatFor(to, { goals: company.goals, projects: company.projects, tree });
      if (seat) open({ kind: "session", id: seat.conversationId });
    },
    openProposal,
    focusTitle: !!panel && panel.kind !== "session" && panel.kind !== "proposal" && sheetId(panel) === focusKey,
    titleSettled: () => setFocusKey(null),
    intent: panel && panel.kind !== "session" && panel.kind !== "proposal" ? panel.intent ?? null : null,
    fills,
  }), [close, open, openProposal, company.goals, company.projects, tree, panel, focusKey, fills]);

  // -------- store actions (or the preview equivalent)
  const slice = useMemo(() => createOrgSlice(), []);
  const run = useCallback(<K extends "createOrgRole" | "updateOrgRole" | "staffHeadOfPeople">(name: K, ...args: Parameters<ReturnType<typeof createOrgSlice>[K]>) => {
    if (preview) {
      setPreviewTree((t) => mutate(t, (draft) => { (slice[name] as any).call({ orgTree: draft }, ...args); }));
      return;
    }
    (useInboxStore.getState() as any)[name](...args);
  }, [preview, slice]);
  const resumeRole = useCallback((roleId: string) => run("updateOrgRole", roleId, { status: "active" }), [run]);

  // -------- permissions, and the reset (S27): it asks the server what it
  // would change, then does it. The preview answers from its own tree.
  const me = tree?.people.find((p) => p.is_me) ?? (meId ? tree?.people.find((p) => p.user_id === meId) : undefined);
  const isAdmin = me?.role === "admin" || me?.role === "owner" || tree?.workspace.kind === "user";
  const resetMutation = useMutation((_api as any).orgRoles.reset);
  const resetArgs = tree?.workspace.kind === "team" ? { team_id: tree.workspace.id } : {};
  const resetPreview = useCallback(async (): Promise<OrgResetPreview> => preview
    ? { roles: (tree?.roles ?? []).filter((r) => r.status !== "retired").map((r) => ({ short_id: r.short_id, handle: r.handle, name: r.name, sessions: r.total })), proposals: previewProposals.length }
    : resetMutation({ ...resetArgs, dry_run: true }), [preview, tree, previewProposals, resetMutation]); // eslint-disable-line react-hooks/exhaustive-deps
  // The real reset goes through the store, so it is classified like every org verb.
  const resetOrg = useCallback(async () => { if (!preview) await useInboxStore.getState().resetOrg(resetArgs.team_id); }, [preview, tree]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = useMemo(() => isAdmin ? { preview: resetPreview, reset: resetOrg, onDone: retryTree } : null, [isAdmin, resetPreview, resetOrg, retryTree]);

  // -------- the Head of People (S16): seat the workspace's existing agent, or hire fresh
  const introSeen = s.clientState.ui?.org_intro_seen === true;
  const markIntroSeen = useCallback(() => {
    if (!preview && !useInboxStore.getState().clientState.ui?.org_intro_seen) useInboxStore.getState().updateClientUI({ org_intro_seen: true });
  }, [preview]);
  const [seatDialog, setSeatDialog] = useState<{ name: string; convId: string; messageCount?: number } | null>(null);
  const doStaffHead = useCallback((seat?: HeadSeatChoice) => {
    const hostId = me?.user_id ?? meId;
    if (!tree || !hostId) return;
    // The provisioned standing session starts in a project, like every
    // session the web starts.
    const projectPath = defaultNewSessionPath(useInboxStore.getState());
    const input = { ...(tree.workspace.kind === "team" ? { team_id: tree.workspace.id } : {}), ...(projectPath ? { project_path: projectPath } : {}), host_user_id: hostId, client_id: `orgrolestub-head-${Math.random().toString(36).slice(2)}`, ...(seat ? { seat } : {}) };
    if (preview) { run("staffHeadOfPeople", input); toast.success("Hiring the head of people", { description: "Its first review lands as a proposal here." }); return; }
    void useInboxStore.getState().staffHeadOfPeople(input).then((r) => {
      const convId = r?.standing?.conversation_id ? String(r.standing.conversation_id) : null;
      const openAction = convId ? { label: "Open the thread", onClick: () => open({ kind: "session", id: convId }) } : undefined;
      if (convId) open({ kind: "session", id: convId });
      if (r?.seated === "existing") {
        // Name what it was, what it is, and that nothing restarted, so seating never reads as a takeover.
        const was = r?.previous_title?.trim();
        toast.success(`Your agent${was ? `, formerly ${was},` : ""} is now your Head of People. Nothing restarted.`, { action: openAction });
      } else if (r?.seated === "fresh") {
        toast.success("Your new Head of People is running", { description: "The old agent was retired. Its thread is kept and linked from its page.", action: openAction });
      } else {
        toast.success("Hiring the head of people", { description: "Its first review lands as a proposal here.", action: openAction });
      }
    }).catch(() => {});
  }, [tree, me, meId, run, preview, open]);
  const hireHeadOfPeople = useCallback(() => {
    if (!tree) return;
    // A workspace with a standing agent already opens the seat dialog; an
    // empty one hires fresh straight away. The existing agent is the root
    // anchor (not a role's standing session).
    const roleAnchorIds = new Set(tree.roles.map((r) => r.anchor_id).filter(Boolean));
    const wsAnchor = tree.anchors.find((a) => a.conversation_id && !roleAnchorIds.has(a.anchor_id));
    if (wsAnchor?.conversation_id) {
      const convId = String(wsAnchor.conversation_id);
      const count = (useInboxStore.getState().sessions as Record<string, { message_count?: number } | undefined>)?.[convId]?.message_count;
      setSeatDialog({ name: wsAnchor.name, convId, messageCount: count });
    } else {
      doStaffHead();
    }
  }, [tree, doStaffHead]);

  // -------- the first visit (S20): seeing the page by any route sells the
  // feature, and the one first-open screen rises once per person.
  useMountEffect(() => {
    if (preview) return;
    const st = useInboxStore.getState();
    if (st.clientStateInitialized) markOrgUpsellSeen(st);
  });
  const [intro, setIntro] = useState<"auto" | null>(null);
  const introOffered = useRef(false);
  const initialized = s.clientStateInitialized;
  useWatchEffect(() => {
    if (introOffered.current || !tree || preview || agentsOff || !initialized || introSeen) return;
    introOffered.current = true;
    setIntro("auto");
  }, [tree, preview, initialized, introSeen]);
  const liveRoles = tree ? tree.roles.filter((r) => r.status !== "retired").length : 0;
  const closeIntro = useCallback((how: "start" | "later") => {
    setIntro(null);
    if (!preview) markOrgIntroSeen(useInboxStore.getState());
    if (how === "start" && liveRoles === 0) hireHeadOfPeople();
  }, [preview, liveRoles, hireHeadOfPeople]);

  /** Review the org now: one review from a fresh session, no hire (S8). The
   *  session opens in the panel once the server names it, so the review can
   *  be watched; its proposal reaches Waits on you. */
  const reviewNow = useCallback(() => {
    if (!tree?.workspace.id) return;
    if (preview) { toast.success("Preview: no review starts"); return; }
    const st = useInboxStore.getState();
    const projectPath = defaultNewSessionPath(st);
    const { stubId } = spawnSessionWithPrompt({
      prompt: "Review this company's organization: run `cast org review` and write the proposal it asks for. Propose the smallest set of changes that removes the bottlenecks you find, with evidence a person can click; apply nothing.",
      projectPath: projectPath ?? undefined,
      failureLabel: "Failed to start the org review",
    });
    const note = toast.loading("Starting a review of the org");
    void st.awaitConvexId(stubId).then((id) => {
      if (!id) { toast.dismiss(note); return; }
      toast.success("Reviewing the org in a fresh session", { id: note, action: { label: "Open", onClick: () => open({ kind: "session", id: String(id) }) } });
    }).catch(() => toast.dismiss(note));
  }, [preview, tree?.workspace.id, open]);

  /** The preview's send: flip the local rows the way each staged answer
   *  would, and clear them from the batch. Nothing leaves the page. */
  const previewSend = useCallback((proposalId: string) => {
    const st = useInboxStore.getState();
    const answers = proposalAnswersOf(st.reviewComments[PREVIEW_BATCH], proposalId);
    if (answers.some((a) => a.proposal.verdict === "approve")) markIntroSeen();
    const at = Date.now();
    setPreviewProposals((rows) => rows.map((p) => p._id !== proposalId ? p : {
      ...p,
      changes: p.changes.map((c) => {
        const a = answers.find((x) => x.proposal.change_ids.includes(c._id) || x.proposal.seqs.includes(c.seq));
        if (!a || !isDecidable(c.status)) return c;
        const text = a.body.trim();
        const reply = { verdict: a.proposal.verdict, ...(text ? { text } : {}), at };
        if (a.proposal.verdict === "approve") return { ...c, status: "applied" as const, decided_at: at, ...(text ? { reply } : {}) };
        if (a.proposal.verdict === "reject") return { ...c, status: "skipped" as const, decided_at: at, reply };
        return { ...c, reply };
      }),
    }));
    for (const a of answers) st.removeReviewComment(PREVIEW_BATCH, a.id);
  }, [markIntroSeen]);
  const previewPanel = useMemo(() => (preview ? { onSend: previewSend } : null), [preview, previewSend]);

  // -------- the surface: the canvas or a read view, behind one read-state
  // gate (a cold load, a refused or failed read says so instead).
  const drawable = readState.kind === "ok" || readState.kind === "stale" || readState.kind === "empty";
  const selected = panel && panel.kind !== "session" && panel.kind !== "proposal" ? panel.ref : null;
  const surface = (
    <div className="relative h-full min-h-0 flex-1 min-w-0" data-org-surface={view}>
      {!drawable ? (
        <OrgReadStateBlock kind={readState.kind as OrgReadBlockKind} message={readState.kind === "error" ? readState.message : undefined} onRetry={readState.kind === "error" ? retryTree : undefined} />
      ) : (
        <div className="h-full overflow-y-auto ol-doc-scroll [container-type:inline-size]" data-org-canvas>
          <CompanyDocument filter={view === "canvas" ? "everything" : view} selected={selected} />
        </div>
      )}
    </div>
  );

  return (
    <CompanyRowsOverride.Provider value={previewCompany}>
    <OrgOpenContext.Provider value={orgOpen}>
      <div ref={measureRef} className="h-full flex flex-col overflow-hidden relative" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-org-screen={fills ? "narrow" : "wide"} data-org-view={view}>
        <OrgProposalFeeders refs={feedRefs} />
        {/* The first visit (S20): one screen over the whole page, header included. */}
        {intro && tree && <OrgIntro key={intro} hasRoles={liveRoles > 0} compact={phone} onStart={() => closeIntro("start")} onLater={() => closeIntro("later")} />}
        <OrgHeader
          tree={tree}
          isAdmin={!!isAdmin}
          meId={me?.user_id ?? meId ?? ""}
          canHire={!agentsOff}
          onCreateRole={(input) => run("createOrgRole", input)}
          onHistory={() => setHistoryOpen(true)}
          onReview={agentsOff ? undefined : reviewNow}
          onReset={reset ? () => setHistoryOpen(true) : undefined}
          onOpen={(kind, ref, focus) => open({ kind, ref }, undefined, { focus })}
        />
        {preview && <OrgPreviewBanner />}
        {readState.kind === "stale" && <OrgStaleBanner message={readState.message} onRetry={retryTree} />}
        <OrgSplit
          open={!!panel}
          fills={fills}
          surface={surface}
          detail={panel && (
            <SheetHostContext.Provider value={host}>
              <OrgDetailPanel
                panel={panel}
                tree={tree}
                proposals={proposals}
                linkLine={panel.kind === "proposal" ? linkLine : null}
                onSwitchWorkspace={(teamId) => void switchWorkspace(teamId)}
                fills={fills}
                onClose={close}
                onResumeRole={resumeRole}
                headConversationId={headConv}
                preview={previewPanel}
              />
            </SheetHostContext.Provider>
          )}
        />
        {seatDialog && (
          <HeadSeatDialog
            open
            onClose={() => setSeatDialog(null)}
            teamId={tree?.workspace.kind === "team" ? tree.workspace.id : undefined}
            agentName={seatDialog.name}
            messageCount={seatDialog.messageCount}
            onConfirm={(seat: HeadSeatChoice) => doStaffHead(seat)}
          />
        )}
        <OrgHistorySheet open={historyOpen} onClose={() => setHistoryOpen(false)} preview={preview} reset={reset} />
      </div>
    </OrgOpenContext.Provider>
    </CompanyRowsOverride.Provider>
  );
}

/** The surface and the panel as one react-resizable-panels Group (§5).
 *  Closed, the panel folds to nothing and the separator hides; open, it takes
 *  the person's size (`layouts.org_detail`, 44% at first), at least 380px and
 *  always leaving the surface 420px; filling a narrow screen, the surface
 *  folds instead, still mounted with its scroll kept. A drag's end is stored;
 *  a double-click puts the panel back at 44%. The width animates on open and
 *  close only, and the panel keeps what it showed while it folds away. */
function OrgSplit({ open, fills, surface, detail }: { open: boolean; fills: boolean; surface: ReactNode; detail: ReactNode }) {
  const size = detailSizeOf(useInboxStore((st) => st.clientState.layouts?.org_detail));
  const folded = !open || fills;
  const split = useFoldingSplit({
    target: detailLayout(open, fills, size),
    folded,
    onPersist: (next) => {
      const d = next[ORG_DETAIL_ID];
      if (d >= 5 && d <= 95) useInboxStore.getState().updateClientLayout("org_detail", { detail: round(d) });
    },
    onReset: () => useInboxStore.getState().updateClientLayout("org_detail", { detail: ORG_DETAIL_DEFAULT }),
  });
  const [moving, setMoving] = useState(false);
  const first = useRef(true);
  useWatchEffect(() => {
    if (first.current) { first.current = false; return; }
    setMoving(true);
    const t = window.setTimeout(() => setMoving(false), SPLIT_MOVE_MS);
    return () => window.clearTimeout(t);
  }, [open]);
  const last = useRef<ReactNode>(null);
  if (open) last.current = detail;
  return (
    <Group
      orientation="horizontal"
      disabled={folded}
      groupRef={split.groupRef}
      elementRef={split.elementRef}
      defaultLayout={split.defaultLayout}
      onLayoutChange={split.onLayoutChange}
      className="org-split flex-1 min-h-0 min-w-0"
      data-org-split={open ? (fills ? "fills" : "open") : "closed"}
      data-org-split-moving={moving ? "" : undefined}
    >
      <Panel id={ORG_CANVAS_ID} minSize={`${ORG_CANVAS_MIN_PX}px`} collapsible={open && fills} collapsedSize={0} className="flex min-h-0 min-w-0" style={{ overflow: "hidden" }}>
        {surface}
      </Panel>
      <Separator className={cn("cc-split", folded && "is-hidden")} onDoubleClick={split.onSeparatorDoubleClick} />
      <Panel id={ORG_DETAIL_ID} minSize={`${ORG_DETAIL_MIN_PX}px`} defaultSize={`${ORG_DETAIL_DEFAULT}%`} collapsible={!open} collapsedSize={0} className="flex min-h-0 min-w-0" style={{ overflow: "hidden" }}>
        {(open || moving) && <div className="flex-1 min-w-0 min-h-0" data-org-detail>{open ? detail : last.current}</div>}
      </Panel>
    </Group>
  );
}
