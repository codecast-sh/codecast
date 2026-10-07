"use client";
// /org: the org screen (docs/architecture/org-staffing.md S41). The Head of
// People's standing conversation on the left, under a strip of the open
// proposals, and the map on the right, read only. Every answer is given on a
// card in the conversation and leaves with the next message; the URL is the
// only durable state (`?proposal=`, `&focus=`, `show`, `beside`, `lens`,
// `proposed`). Under 980px the columns stack behind a switch; opened beside
// the Head of People's own thread (`?beside=`) only the map draws.
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { create as mutate } from "mutative";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { defaultNewSessionPath, useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { createOrgSlice } from "../../store/orgSlice";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncOrgProposal, useSyncOrgProposals } from "../../hooks/useSyncOrgProposals";
import { useSwitchWorkspace } from "../../hooks/useSwitchWorkspace";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpenLinkedSession } from "../../hooks/useOpenLinkedSession";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useInitiatives } from "../../hooks/useInitiatives";
import { nextFrame } from "../conversationScroll";
import { useMeasuredWidth } from "../../hooks/useMeasuredWidth";
import { cssZoomOf } from "../../lib/cssZoom";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { isConvexId } from "../../lib/entityLinks";
import { workspaceDisplayName } from "../../lib/workspaceScope";
import { markOrgIntroSeen, markOrgUpsellSeen } from "../../lib/orgIntro";
import { proposalAnswersOf } from "../../lib/reviewActions";
import { cn } from "../../lib/utils";
import { useTabContext } from "../../lib/tabParams";
import { OrgHeader } from "./OrgHeader";
import { OpenProposalsStrip, type LinkLineState, type StripRow } from "./OpenProposalsStrip";
import { OrgConversation, PREVIEW_BATCH } from "./OrgConversation";
import { OrgMapColumn } from "./OrgMapColumn";
import { OrgPreviewBanner, OrgStaleBanner } from "./OrgReadStateBlock";
import { OrgHistorySheet } from "./OrgHistorySheet";
import { OrgProposalFeeders } from "./OrgProposalFeeders";
import { OrgHoverContext } from "./proposalContexts";
import { OrgIntro } from "./OrgIntro";
import { HeadSeatDialog, type HeadSeatChoice } from "./HeadSeatDialog";
import { orgTreeReadState } from "./orgReadState";
import { findHeadOfPeople, isDecidable, openProposals, orgPreviewEnabled, pickProposal, resolveProposalLink, reviewRunState, type OrgReviewRun } from "./staffingModel";
import { findProposalCardMessage, missionOf, openProposalsToFeed, orgScreenParams, stripRows, ORG_STACK_BELOW, type JumpRequest, type OrgScreenShow } from "./orgScreenModel";
import { GOALS_FIXTURE_DATA, ORG_GOALS_FIXTURE_PROPOSAL } from "./goalsFixture";
import { ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL } from "./orgStaffingFixture";
import { readOrgPreviewSpec, readOrgPreviewTree } from "./orgPreviewSpec";
import { ORG_FIXTURE_WITH_HEAD } from "./orgFixture";
import { joinProposals, type OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";
import type { OrgFocusTarget } from "./orgLayout";
import type { OrgResetPreview } from "./orgMeta";
import type { MapFilter } from "./OrgMap";
import type { ChartPointer } from "./orgChartPointer";

/** The DEV preview flag is read from the live URL on every render (see
 *  orgPreviewEnabled): a module constant survived in-app navigation and kept
 *  painting fixtures on a workspace with no tree after the flag was gone. */
const ORG_PREVIEW_DEV = !!import.meta.env.DEV;

/** Room above a card's head when the thread lands on it. */
const CARD_LANDING_PAD = 12;

/** How long the landing waits for a card to draw its entries before it
 *  lands on whatever is there (a feeder that never answers). */
const CARD_LANDING_WAIT_MS = 2500;
/** How long a request waits for the thread's rows before it jumps by time. */
const TAIL_WAIT_MS = 3000;
/** How long the landing started with the request waits for the card to mount. */
const CARD_MOUNT_WAIT_MS = 8000;

/** The thread has settled on the message that draws the card (JumpRequest
 *  onSettled): the card's head goes to the top of the view, and the focused
 *  entry (a `&focus=` link) is centred when it sits outside the view. One
 *  message can draw several cards, so the message's top is not the landing.
 *  The card's change rows arrive from their own feeder, often after the
 *  settle, and a card that is still loading grows under the view, so the
 *  landing waits (a frame at a time, capped) until the card has drawn its
 *  entries and, when a focus is set, the focused entry. One write each,
 *  inside the thread's own scroller; the thread's settle treats the move as
 *  a takeover and stops, so nothing pulls the view back. */
function landOnProposalCard(shortId: string, focused: boolean, deadline = performance.now() + CARD_LANDING_WAIT_MS) {
  const card = document.querySelector<HTMLElement>(`[data-org-conversation] [data-proposal-card="${shortId}"]`);
  const scroller = card?.closest<HTMLElement>("[data-sv-feed]");
  if (!card || !scroller) { if (performance.now() < deadline) nextFrame(() => landOnProposalCard(shortId, focused, deadline)); return; }
  const ready = !card.querySelector("[data-proposal-loading]") && (!focused || !!card.querySelector("[data-focused]"));
  if (!ready && performance.now() < deadline) { requestAnimationFrame(() => landOnProposalCard(shortId, focused, deadline)); return; }
  const zoom = cssZoomOf(scroller);
  let view = scroller.getBoundingClientRect();
  scroller.scrollTop += (card.getBoundingClientRect().top - view.top) / zoom - CARD_LANDING_PAD;
  // The innermost focused element: a focused record line sits inside its focused group.
  const entry = Array.from(card.querySelectorAll<HTMLElement>("[data-focused]")).pop();
  if (!entry) return;
  view = scroller.getBoundingClientRect();
  const r = entry.getBoundingClientRect();
  if (r.top >= view.top && r.bottom <= view.bottom) return;
  scroller.scrollTop += (r.top + r.height / 2 - (view.top + view.height / 2)) / zoom;
}

export function OrgScreen() {
  const { tree: storeTree, ready, missing, refused, error: treeError, retry: retryTree } = useSyncOrgTree();
  useSyncOrgProposals();
  // Proposals are two collections (list rows, and the changes of fed
  // proposals) joined at render; the focus scalar is what a `?focus=` link
  // sets and the cards read (org-staffing.md S5).
  const s = useTrackedStore([
    (st) => st.currentUser?._id,
    (st) => st.clientState.ui?.active_team_id,
    (st) => st.orgProposals,
    (st) => st.orgProposalChanges,
    (st) => st.orgFocusChangeId,
    (st) => st.orgIntentNotice?.at,
    (st) => st.teams,
    (st) => st.clientState.ui?.org_intro_seen,
    (st) => st.clientStateInitialized,
    (st) => st.clientState.ui?.org_review_run?.since,
    (st) => st.clientState.ui?.org_review_run?.session_id,
    // The review session's liveness, two fields of one row (never the row):
    // a finished turn or a closed session with no proposal is "ended".
    (st) => { const id = st.clientState.ui?.org_review_run?.session_id; return id ? st.sessions[id]?.is_idle : undefined; },
    (st) => { const id = st.clientState.ui?.org_review_run?.session_id; return id ? st.sessions[id]?.status : undefined; },
    // The strip's answer counts: the head's batch, and the preview's.
    (st) => { const conv = findHeadOfPeople(st.orgTree)?.standing?.conversation_id; return conv ? st.reviewComments[conv] : undefined; },
    (st) => st.reviewComments[PREVIEW_BATCH],
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
  const switchWorkspace = useSwitchWorkspace();
  const openLinked = useOpenLinkedSession();
  const phone = useIsPhone();
  const now = useCoarseNow(30_000);
  const { width, measureRef } = useMeasuredWidth();
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
  // The review "Propose an org now" started lives in the prefs bag
  // (ClientUI.org_review_run), so a reload or a visit elsewhere does not
  // forget it and offer a second one. The preview keeps its own copy: it
  // must never write a pref.
  const [previewRun, setPreviewRun] = useState<OrgReviewRun | null>(null);
  // The slot holds one tree. After a workspace switch it still holds the
  // previous workspace's until the new answer lands; a tree that names another
  // workspace is not this page's data, so paint the skeleton for that round
  // trip instead of a foreign org. Personal = the viewer's own user id.
  const wantedWorkspace = activeTeamId && isConvexId(activeTeamId) ? activeTeamId : meId;
  const treeMatches = !storeTree || !wantedWorkspace || storeTree.workspace.id === wantedWorkspace;
  const tree: OrgTree | null = preview ? previewTree : treeMatches ? storeTree : null;

  // -------- derived
  const proposals = useMemo<OrgProposalRow[]>(() => preview ? previewProposals : joinProposals(s.orgProposals, s.orgProposalChanges), [preview, previewProposals, s.orgProposals, s.orgProposalChanges]);
  const workspaceProposals = useMemo(() => {
    const wanted = tree?.workspace;
    return wanted ? proposals.filter((p) => wanted.kind === "team" ? p.team_id === wanted.id : !p.team_id) : proposals;
  }, [proposals, tree]);
  const open = useMemo(() => openProposals(workspaceProposals), [workspaceProposals]);
  const linkedRef = params.proposal;
  const linked = useMemo(() => pickProposal(workspaceProposals, linkedRef), [workspaceProposals, linkedRef]);
  // The linked proposal, whatever workspace it lives in: the get feeder fills
  // its row and changes, and the resolver names a foreign or unreadable link.
  const lookup = useSyncOrgProposal(preview ? null : linkedRef);
  const activeWorkspace = tree ? { kind: tree.workspace.kind, id: tree.workspace.id } : null;
  const linkState = useMemo(() => preview ? { kind: "open" as const } : resolveProposalLink(linkedRef, proposals, activeWorkspace, lookup), [preview, linkedRef, proposals, activeWorkspace?.kind, activeWorkspace?.id, lookup.ready, lookup.missing]); // eslint-disable-line react-hooks/exhaustive-deps
  const head = useMemo(() => findHeadOfPeople(tree), [tree]);
  const headConv = head?.standing?.conversation_id ?? null;
  const batchId = preview ? PREVIEW_BATCH : headConv;
  const feedRefs = useMemo(() => preview ? [] : openProposalsToFeed(workspaceProposals, linkedRef), [preview, workspaceProposals, linkedRef]);
  // The map draws the linked proposal when it is open here, else the newest open one on this thread.
  const mapRow = (linkedRef && linked?.status === "open" ? linked : open.find((p) => p.thread?.conversation_id === headConv)) ?? null;
  const mapProposal = useMemo(() => mapRow ? { changes: mapRow.changes } : null, [mapRow?._id, mapRow?.changes]); // eslint-disable-line react-hooks/exhaustive-deps
  // What the screen says about the read itself (orgReadState.ts): a failure
  // or a refusal is said, never painted as an empty chart.
  const readState = useMemo(() => orgTreeReadState({ hasTree: !!tree, hasNodes: (tree?.roles.length ?? 0) + (tree?.people.length ?? 0) > 0, ready, missing, refused: !preview && refused, error: preview ? null : treeError }), [tree, ready, missing, refused, treeError, preview]);
  const storeInitiatives = useInitiatives();
  const mission = useMemo(() => missionOf(preview ? GOALS_FIXTURE_DATA.initiatives : storeInitiatives), [preview, storeInitiatives]);

  // -------- layout: wide, stacked behind a switch, or the map alone beside the head's own thread
  const stacked = phone || (width ?? (typeof window !== "undefined" ? window.innerWidth : ORG_STACK_BELOW)) < ORG_STACK_BELOW;
  const mapOnly = !!params.beside && params.beside === headConv;
  const mode = mapOnly ? "map-only" : stacked ? "stacked" : "wide";
  const show: OrgScreenShow = params.show ?? "conversation";
  // The screen takes its tab's width while it is mounted (store.stageWide):
  // the session rail and any sibling pane fold to a thin rail and come back
  // when the leaf navigates away or closes, or when the person clicks the
  // rail. Not when opened beside a conversation on purpose (`?beside=`):
  // side by side was the ask there. Ephemeral: the arrangement underneath is
  // never rewritten.
  const tabCtx = useTabContext();
  const wideTabId = tabCtx && !params.beside ? tabCtx.tabId : null;
  const wideLeafId = tabCtx?.leafId ?? null;
  useWatchEffect(() => {
    if (!wideTabId) return;
    const wide = { tabId: wideTabId, leafId: wideLeafId };
    useInboxStore.getState().setStageWide(wide);
    return () => {
      const st = useInboxStore.getState();
      if (st.stageWide && st.stageWide.tabId === wide.tabId && st.stageWide.leafId === wide.leafId) st.setStageWide(null);
    };
  }, [wideTabId, wideLeafId]);

  // -------- the URL (the only durable state)
  const replaceParams = useCallback((edit: (params: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams.toString());
    edit(next);
    const qs = next.toString();
    router.replace(qs ? `/org?${qs}` : "/org");
  }, [searchParams, router]);
  const setProposalParam = useCallback((shortId: string | null) => replaceParams((p) => { if (shortId) p.set("proposal", shortId); else p.delete("proposal"); p.delete("focus"); }), [replaceParams]);
  const setShow = useCallback((v: OrgScreenShow) => replaceParams((p) => p.set("show", v)), [replaceParams]);
  const setFilter = useCallback((f: MapFilter) => replaceParams((p) => { if (f === "everything") p.delete("lens"); else p.set("lens", f); }), [replaceParams]);
  const setAsProposed = useCallback((on: boolean) => replaceParams((p) => { if (on) p.delete("proposed"); else p.set("proposed", "0"); }), [replaceParams]);
  /** A pointer the followed thread wrote (OrgMapColumn): the proposal, the focus and the lens, each set or cleared. */
  const applyPointer = useCallback((ptr: ChartPointer) => replaceParams((p) => {
    for (const [k, v] of [["proposal", ptr.proposal], ["focus", ptr.focus], ["lens", ptr.lens === "everything" ? undefined : ptr.lens]] as const) { if (v) p.set(k, v); else p.delete(k); }
  }), [replaceParams]);

  // -------- scroll to a card (S41): the message that draws it when it is
  // loaded, else its time, and the embed finds the card in the window that
  // lands (a timestamp jump keeps its window in the hook, never the store).
  const [jump, setJump] = useState<JumpRequest | null>(null);
  const jumpSeq = useRef(0);
  // The thread's rows arrive a moment after the screen mounts, and the card
  // is nearly always among them: a request made before they land waits for
  // them (briefly) instead of jumping by time, because the window around a
  // proposal's creation can end before its card when the author was busy.
  const waiting = useRef<{ p: OrgProposalRow; focused: boolean; timer: number } | null>(null);
  const tailLength = useInboxStore((st) => (headConv ? st.messages[headConv]?.length ?? 0 : 0));
  useWatchEffect(() => () => { if (waiting.current) { window.clearTimeout(waiting.current.timer); waiting.current = null; } }, []);
  const scrollToProposal = useCallback((p: OrgProposalRow, focused = false) => {
    if (!headConv) return;
    const tail = useInboxStore.getState().messages[headConv];
    const id = findProposalCardMessage(tail, p.short_id);
    // The rows that could hold the card are the ones after the proposal was
    // posted: until the tail reaches past that time it has not arrived yet.
    const caughtUp = !!tail?.length && (tail[tail.length - 1]?.timestamp ?? 0) > p.created_at;
    if (waiting.current) { window.clearTimeout(waiting.current.timer); waiting.current = null; }
    if (!id && !caughtUp) {
      const timer = window.setTimeout(() => { if (waiting.current?.p === p) { waiting.current = null; scrollToProposal(p, focused); } }, TAIL_WAIT_MS);
      waiting.current = { p, focused, timer };
      return;
    }
    const nonce = ++jumpSeq.current;
    const onSettled = () => landOnProposalCard(p.short_id, focused);
    setJump(id ? { messageId: id, nonce, onSettled } : { timestamp: p.created_at, find: p.short_id, nonce, onSettled });
    // The landing also starts now and waits for the card to mount: the thread
    // settles on frames and in a hidden tab never reports settling, while the
    // card still mounts once the list scrolls near it.
    landOnProposalCard(p.short_id, focused, performance.now() + CARD_MOUNT_WAIT_MS);
  }, [headConv]);
  useWatchEffect(() => {
    const w = waiting.current;
    if (w && tailLength > 0) { waiting.current = null; scrollToProposal(w.p, w.focused); }
  }, [tailLength]);

  // `?proposal=op-N` on arrival, once per ref: the card on this thread is
  // scrolled to; a proposal written on another thread expands in the strip.
  const [expandedForeign, setExpandedForeign] = useState<string | null>(null);
  const arrived = useRef<string | null>(null);
  // The address the screen opened on: a link that named a proposal and asked
  // for the map keeps the map; any later link lands on the card.
  const opened = useRef(params);
  useWatchEffect(() => {
    if (!params.proposal || !headConv || !linked || linked.short_id !== params.proposal || linked.status !== "open") return;
    if (arrived.current === params.proposal) return;
    arrived.current = params.proposal;
    if (mapOnly) return;
    if (linked.thread?.conversation_id === headConv) scrollToProposal(linked, params.focus !== null); else setExpandedForeign(linked.short_id);
    if (stacked && params.show === "map" && !(opened.current.show === "map" && opened.current.proposal === params.proposal)) setShow("conversation");
  }, [params.proposal, headConv, linked?._id, linked?.status, linked?.thread?.conversation_id, mapOnly]);

  // `?proposal=op-N&focus=<n>` is the link of one change (`op-N#n`): the
  // cards light the subject holding it and the map pans to it. Once per
  // proposal and number, so a person who then picks another entry is not
  // pulled back; a number whose row has not landed yet is tried again when
  // the rows do.
  const focusApplied = useRef<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<OrgFocusTarget | null>(null);
  const focusSeq = useRef(0);
  useWatchEffect(() => {
    if (!linked || linked.short_id !== params.proposal || params.focus === null) return;
    const key = `${linked._id}#${params.focus}`;
    if (focusApplied.current === key) return;
    const change = linked.changes.find((c) => c.seq === params.focus && c.status !== "removed");
    if (!change) return;
    focusApplied.current = key;
    useInboxStore.getState().setOrgFocusChangeId(change._id);
    setFocusTarget({ kind: "change", id: change._id, seq: ++focusSeq.current });
  }, [linked?._id, linked?.changes, params.proposal, params.focus]);
  // Leaving the screen clears the focus; the once-guard goes with it, so a
  // remount (StrictMode's dev double mount included) applies the link again.
  useMountEffect(() => () => { focusApplied.current = null; useInboxStore.getState().setOrgFocusChangeId(null); });
  const clearFocus = useCallback(() => {
    useInboxStore.getState().setOrgFocusChangeId(null);
    if (params.focus !== null) replaceParams((p) => p.delete("focus"));
  }, [params.focus, replaceParams]);
  // A hovered subject card lights its node; the focused change is the fallback.
  const [hoverChangeId, setHoverChangeId] = useState<string | null>(null);
  const highlightChangeId = hoverChangeId ?? s.orgFocusChangeId;

  // The compose text lands in the standing session's store draft, which is
  // what the embedded composer seeds from (MessageInput reads getDraft), then
  // the parameter leaves the URL so a reload does not seed it twice. A draft
  // the person already typed wins.
  useWatchEffect(() => {
    if (!params.compose || !headConv) return;
    const st = useInboxStore.getState();
    const existing = st.getDraft(headConv) ?? {};
    if (!existing.draft_message) st.setDraft(headConv, { ...existing, draft_message: params.compose });
    replaceParams((p) => p.delete("compose"));
  }, [params.compose, headConv]);
  // `?panel=history` (the undo timeline's "Open in org record") opens the sheet; the param then leaves the URL.
  const [historyOpen, setHistoryOpen] = useState(false);
  useWatchEffect(() => {
    if (!params.history) return;
    setHistoryOpen(true);
    replaceParams((p) => p.delete("panel"));
  }, [params.history]);

  // -------- the strip
  const comments = batchId ? s.reviewComments[batchId] : undefined;
  const rows = useMemo(() => stripRows(open, headConv, comments, now, preview), [open, headConv, comments, now, preview]);
  const answersStaged = rows.some((r) => r.answered > 0);
  const linkLine = useMemo<LinkLineState | null>(() => {
    if (linkState.kind === "open") return null;
    if (linkState.kind !== "foreign") return linkState;
    const ws = linkState.workspace;
    return { kind: "foreign", shortId: linkState.shortId, workspaceName: workspaceDisplayName(ws, s.teams, meId), teamId: ws.kind === "team" ? ws.id : null };
  }, [linkState, s.teams, meId]);
  const onPick = useCallback((row: StripRow) => {
    const id = row.proposal.short_id;
    // The click is the arrival: the URL effect must not scroll a second time.
    arrived.current = id;
    // One replace: the proposal and, stacked, the column. Two replaces from
    // one render's address would each start from the same snapshot, and the
    // second would drop the first's proposal.
    replaceParams((p) => { p.set("proposal", id); p.delete("focus"); if (stacked && !row.foreign) p.set("show", "conversation"); });
    if (row.foreign) { setExpandedForeign((cur) => (cur === id ? null : id)); return; }
    // A card on this thread is the one open thing: a foreign card still open
    // under the line would sit over the thread scrolling to another.
    setExpandedForeign(null);
    scrollToProposal(row.proposal);
  }, [replaceParams, scrollToProposal, stacked]);
  /** The breadcrumb's x: the address forgets the proposal, the card under the
   *  line closes, and a later link to the same proposal arrives afresh. */
  const clearProposal = useCallback(() => {
    setExpandedForeign(null);
    arrived.current = null;
    setProposalParam(null);
  }, [setProposalParam]);

  // -------- store actions (or the preview equivalent)
  const slice = useMemo(() => createOrgSlice(), []);
  const run = useCallback(<K extends "createOrgRole" | "updateOrgRole" | "staffHeadOfPeople">(name: K, ...args: Parameters<ReturnType<typeof createOrgSlice>[K]>) => {
    if (preview) {
      setPreviewTree((t) => mutate(t, (draft) => { (slice[name] as any).call({ orgTree: draft }, ...args); }));
      return;
    }
    (useInboxStore.getState() as any)[name](...args);
  }, [preview, slice]);

  // -------- permissions
  const me = tree?.people.find((p) => p.is_me) ?? (meId ? tree?.people.find((p) => p.user_id === meId) : undefined);
  const isAdmin = me?.role === "admin" || me?.role === "owner" || tree?.workspace.kind === "user";
  // Reset (S27) asks the server what it would change, then does it. The
  // preview's fixture answers from its own tree and changes nothing.
  const resetMutation = useMutation((_api as any).orgRoles.reset);
  const resetArgs = tree?.workspace.kind === "team" ? { team_id: tree.workspace.id } : {};
  const resetPreview = useCallback(async (): Promise<OrgResetPreview> => preview
    ? { roles: (tree?.roles ?? []).filter((r) => r.status !== "retired").map((r) => ({ short_id: r.short_id, handle: r.handle, name: r.name, sessions: r.total })), proposals: previewProposals.length }
    : resetMutation({ ...resetArgs, dry_run: true }), [preview, tree, previewProposals, resetMutation]); // eslint-disable-line react-hooks/exhaustive-deps
  // The real reset goes through the store, so it is classified like every org verb.
  const resetOrg = useCallback(async () => { if (!preview) await useInboxStore.getState().resetOrg(resetArgs.team_id); }, [preview, tree]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = useMemo(() => isAdmin ? { preview: resetPreview, reset: resetOrg, onDone: retryTree } : null, [isAdmin, resetPreview, resetOrg, retryTree]);

  const openSession = useCallback((conversationId: string) => {
    if (preview) return;
    openLinked({ _id: conversationId, updated_at: Date.now() });
  }, [preview, openLinked]);
  // The letter's line of introduction (S19) goes for good once a person
  // accepts a change; the pref follows them to every device.
  const introSeen = s.clientState.ui?.org_intro_seen === true;
  const markIntroSeen = useCallback(() => {
    if (!preview && !useInboxStore.getState().clientState.ui?.org_intro_seen) useInboxStore.getState().updateClientUI({ org_intro_seen: true });
  }, [preview]);
  /** A paused Head of People's triggers hold until resumed; the conversation says so and
   *  this is its Resume. */
  const resumeHeadOfPeople = useCallback((roleId: string) => run("updateOrgRole", roleId, { status: "active" }), [run]);
  // S16: the seat-the-existing-agent moment, opened by hireHeadOfPeople when a
  // standing agent already exists.
  const [seatDialog, setSeatDialog] = useState<{ name: string; convId: string; messageCount?: number } | null>(null);
  // Staff the Head of People (S16). `seat` says what to do with the workspace's existing
  // standing agent: seat it (default, nothing restarts) or start fresh and
  // retire the old one. After a seat, route to the thread and say what changed.
  const doStaffHead = useCallback((seat?: HeadSeatChoice) => {
    const host = me?.user_id ?? meId;
    if (!tree || !host) return;
    // The provisioned standing session starts in a project, like every
    // session the web starts (the same resolution proposeNow uses).
    const st = useInboxStore.getState();
    const projectPath = defaultNewSessionPath(st);
    const input = { ...(tree.workspace.kind === "team" ? { team_id: tree.workspace.id } : {}), ...(projectPath ? { project_path: projectPath } : {}), host_user_id: host, client_id: `orgrolestub-head-${Math.random().toString(36).slice(2)}`, ...(seat ? { seat } : {}) };
    if (preview) { run("staffHeadOfPeople", input); toast.success("Hiring the head of people", { description: "Its first review lands as a proposal here." }); return; }
    void useInboxStore.getState().staffHeadOfPeople(input).then((r) => {
      // Route to the thread and say what changed (S16). A seat keeps the agent;
      // a fresh start replaces it. When no thread came back, the review still
      // lands as a proposal on this page.
      const convId = r?.standing?.conversation_id;
      const openAction = convId ? { label: "Open the thread", onClick: () => openSession(convId) } : undefined;
      if (convId) openSession(convId);
      if (r?.seated === "existing") {
        // The contract's own words (S16): name what it was, what it is, and
        // that nothing restarted, so seating never reads as a takeover.
        const was = r?.previous_title?.trim();
        toast.success(`Your agent${was ? `, formerly ${was},` : ""} is now your Head of People. Nothing restarted.`, { action: openAction });
      } else if (r?.seated === "fresh") {
        toast.success("Your new Head of People is running", { description: "The old agent was retired. Its thread is kept and linked from its page.", action: openAction });
      } else {
        toast.success("Hiring the head of people", { description: "Its first review lands as a proposal here.", action: openAction });
      }
    }).catch(() => {});
  }, [tree, me, meId, run, preview, openSession]);
  // -------- the first visit (S20)
  // Seeing the org page by any route sells the feature: the card that
  // introduces it elsewhere never rises afterwards.
  useMountEffect(() => {
    if (preview) return;
    const st = useInboxStore.getState();
    if (st.clientStateInitialized) markOrgUpsellSeen(st);
  });
  // The one first-open flow: the one screen built from the faces, over the
  // body. Opens on its own once the tree and the prefs have landed and
  // org_intro_seen is unset. Either action writes the pref, so it is seen
  // once per person.
  const [intro, setIntro] = useState<"auto" | null>(null);
  const introOffered = useRef(false);
  const initialized = s.clientStateInitialized;
  useWatchEffect(() => {
    if (introOffered.current || !tree || preview || !initialized || introSeen) return;
    introOffered.current = true;
    setIntro("auto");
  }, [tree, preview, initialized, introSeen]);
  const hireHeadOfPeople = useCallback(() => {
    if (!tree) return;
    // The explained moment (S16): a workspace with a standing agent already
    // opens the seat dialog; an empty one hires fresh straight away. The
    // existing agent is the root anchor (not a role's standing session).
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
  const liveRoles = tree ? tree.roles.filter((r) => r.status !== "retired").length : 0;
  /** Either action closes the screen and writes the pref (S20). The start
   *  action asks the head of people when the workspace has no roles; with
   *  roles the map is already under the screen. */
  const closeIntro = useCallback((how: "start" | "later") => {
    setIntro(null);
    if (!preview) markOrgIntroSeen(useInboxStore.getState());
    if (how === "start" && liveRoles === 0) hireHeadOfPeople();
  }, [preview, liveRoles, hireHeadOfPeople]);
  /** "Propose an org now": one review from a fresh session, no hire (S8).
   *  Rides the same spawn route as every session the web starts. */
  const proposeNow = useCallback(() => {
    const workspace = tree?.workspace.id;
    if (!workspace) return;
    const since = Date.now();
    if (preview) {
      setPreviewRun({ since, session_id: null, workspace });
      // The fixture lands after a beat so the reviewing state can be seen.
      setTimeout(() => setPreviewProposals((rows) => rows.length ? rows : [{ ...ORG_STAFFING_FIXTURE_PROPOSAL, created_at: Date.now() }]), 1500);
      return;
    }
    const st = useInboxStore.getState();
    const projectPath = defaultNewSessionPath(st);
    const { stubId } = spawnSessionWithPrompt({
      prompt: "Review this company's organization: run `cast org review` and write the proposal it asks for. Propose the smallest set of changes that removes the bottlenecks you find, with evidence a person can click; apply nothing.",
      projectPath: projectPath ?? undefined,
      failureLabel: "Failed to start the org review",
    });
    st.updateClientUI({ org_review_run: { since, session_id: stubId, workspace } });
    // The stub is re-keyed when the server names the row; follow it so the
    // link still opens the session after that, and its liveness can be read.
    void st.awaitConvexId(stubId).then((id) => {
      const cur = useInboxStore.getState().clientState.ui?.org_review_run;
      if (id && cur?.since === since) useInboxStore.getState().updateClientUI({ org_review_run: { ...cur, session_id: String(id) } });
    }).catch(() => {});
    toast.success("Reviewing the company in a fresh session");
  }, [preview, tree?.workspace.id]);
  // Reviewing until a proposal newer than the click lands, or the TTL passes
  // (`now` is the coarse clock, so the state falls back on its own).
  const reviewRun: OrgReviewRun | null = preview ? previewRun : s.clientState.ui?.org_review_run ?? null;
  const reviewRow = reviewRun?.session_id ? s.sessions[reviewRun.session_id] : undefined;
  const reviewState = reviewRunState(reviewRun, now, tree?.workspace.id ?? null, workspaceProposals, reviewRow ? { is_idle: reviewRow.is_idle, status: reviewRow.status } : null);
  const reviewing = reviewState === "reviewing";
  const reviewSession = reviewState === "none" ? null : reviewRun?.session_id ?? null;
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
  const previewColumn = useMemo(() => preview ? { proposals: previewProposals, onSend: previewSend, current: params.proposal } : null, [preview, previewProposals, previewSend, params.proposal]);

  const strip = mapOnly ? null : (
    <OpenProposalsStrip rows={rows} current={params.proposal} expanded={expandedForeign} batchConversationId={batchId} linkLine={linkLine} onPick={onPick} onCollapse={() => setExpandedForeign(null)} onClearCurrent={clearProposal} onSwitchWorkspace={(teamId) => void switchWorkspace(teamId)} />
  );
  const conversation = (
    <div className="h-full min-h-0" onKeyDown={(e) => { if (e.key === "Escape" && s.orgFocusChangeId) clearFocus(); }}>
      <OrgConversation
        tree={tree}
        head={head}
        conversationId={headConv}
        readState={readState}
        onRetry={retryTree}
        reviewing={reviewing}
        reviewEnded={reviewState === "ended"}
        reviewSessionId={reviewSession}
        onProposeNow={proposeNow}
        jump={jump}
        answersStaged={answersStaged}
        onOpenSession={openSession}
        onResume={resumeHeadOfPeople}
        strip={strip}
        preview={previewColumn}
      />
    </div>
  );
  const map = (
    <OrgMapColumn
      tree={tree}
      readState={readState}
      onRetry={retryTree}
      goals={preview ? GOALS_FIXTURE_DATA : undefined}
      proposal={mapProposal}
      filter={params.lens}
      onFilter={setFilter}
      asProposed={params.proposed}
      onAsProposed={setAsProposed}
      highlightChangeId={highlightChangeId}
      focusTarget={focusTarget}
      onOpenSession={openSession}
      beside={params.beside}
      onPointer={applyPointer}
    />
  );

  return (
    <OrgHoverContext.Provider value={setHoverChangeId}>
      <div ref={measureRef} className="h-full flex flex-col overflow-hidden relative" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-org-screen={mode}>
        <OrgProposalFeeders refs={feedRefs} />
        {/* the first visit (S20): the one screen over the whole page, header
            included, so it fits a laptop without a scroll; its own title says
            where the person is. Later or the start action brings the page back. */}
        {intro && tree && <OrgIntro key={intro} hasRoles={liveRoles > 0} compact={phone} onStart={() => closeIntro("start")} onLater={() => closeIntro("later")} />}
        {!mapOnly && <OrgHeader tree={tree} mission={mission} isAdmin={!!isAdmin} healthOn={false} phone={phone} meId={me?.user_id ?? meId ?? ""} onCreateRole={(input) => run("createOrgRole", input)} onHistory={() => setHistoryOpen(true)} proposal={mapRow} />}
        {preview && !mapOnly && <OrgPreviewBanner />}
        {readState.kind === "stale" && <OrgStaleBanner message={readState.message} onRetry={retryTree} />}
        {mode === "stacked" && (
          <div role="tablist" aria-label="Conversation or map" className="shrink-0 h-9 px-3 flex items-center border-b" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }} data-org-switch={show}>
            <div className="inline-flex h-7 items-center rounded-lg border p-[2px]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", background: "var(--sol-card)" }}>
              {(["conversation", "map"] as const).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={show === v} onClick={() => setShow(v)} className={cn("inline-flex h-full items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors", show === v ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/50")} style={{ color: show === v ? "var(--sol-text)" : "var(--sol-text-muted)" }} data-org-switch-pick={v}>
                  {v === "conversation" ? "Conversation" : "Map"}
                  {v === "conversation" && rows.length > 0 && <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[10px] font-semibold tabular-nums" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>{rows.length}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* The conversation keeps its place in the tree whatever the mode, so
            a flip between wide and stacked (a pane folding beside the screen,
            a window resize) never remounts the thread mid-jump: stacked on the
            map, it is hidden, not gone. Wide: the conversation keeps room for
            the cards' wide layout (561px and up); the map takes 40%, never
            under 360px or over 620px. */}
        <div className="flex-1 min-h-0 relative flex">
          {!mapOnly && (
            <div
              className={cn("min-h-0", mode === "wide" ? "flex-1 min-w-[560px] border-r" : "flex-1", mode === "stacked" && show !== "conversation" && "hidden")}
              style={mode === "wide" ? { borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" } : undefined}
              data-org-column="conversation"
            >{conversation}</div>
          )}
          {/* The map mounts only where it shows: a map laid out behind the
              thread would still measure and pan for nothing. */}
          {(mode !== "stacked" || show === "map") && (
            <div className={cn("min-h-0", mode === "wide" ? "w-[40%] min-w-[360px] max-w-[620px]" : "flex-1")} data-org-column="map">{map}</div>
          )}
        </div>

        {/* seat the Head of People (S16) */}
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
    </OrgHoverContext.Provider>
  );
}
