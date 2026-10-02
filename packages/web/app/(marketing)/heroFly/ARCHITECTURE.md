# Hero fly-through architecture: rendering the real product UI

## Summary

The product has one live store. `useInboxStore` (store/inboxStore.ts:12843) is a singleton, and `useTrackedStore` reads it directly at :12954. Every `action()` it runs writes IndexedDB and queues a server write in a persisted outbox, even on the marketing route (bootPersistence at :13471). That outbox is sent the next time the visitor opens `/inbox`. So the hero never writes to that store and never reads the visitor's data.

What makes that possible:

- **Split each component into a container and a view.** The view takes only props. The product's container renders the view, and the hero renders the same view with fixture data. There is one rendering path.
- **One sandbox wrapper** that neutralises what a view might still reach:
  - Convex, replaced by a stub provider.
  - Entity pills, answered from fixtures.
  - The personify setting, overridden.
  - Theme, forced light.
  - Navigation, drag and context menus, cancelled.
  - Errors, caught at the hero.
- **No store seeding and no iframe realm for the main film.** An iframe realm is only a fallback if a whole container ever has to be mounted (see section 1).

I read the maps and checked a few facts in the code. I edited nothing.

---

## 0. Feature coverage plan

The film grows from 7 chapters in 36s to 12 chapters in about 84s. It still tells one story from start to end: "retry failed webhooks" is asked for, fanned out, answered from a phone, discussed, decided, tracked, automated, discussed with the team, merged, published, and found again three weeks later.

The world stays a loop around the desk. Each chapter has one hold with at most two surfaces in view, a caption strip, and a chapter tick. Ticks seek to the hold's start.

"Light interaction" means local state only; the handlers are the hero's own.

| # | t (s) | Capability group | Scene / surface | Real components | Fixture content | Light interaction |
|---|---|---|---|---|---|---|
| 1 | 2.4–9 | Capture, Inbox and triage | `desk`: app window | `SessionCardView` (new), `SectionHeader` (new), `InboxViewMenu`, sidebar primitives (`RailHeading`, `SectionRow`, `NavCount`, `NavSection`, `InboxNavRow`), `TopbarButton`, `StatusDot`, `SearchField` (new), `AgentTypeIcon`, `SessionWorktreeChip`, `PrStatusChip` | 6 rows from 5 agents (claude_code, codex, cursor, gemini, pi): one working (green ping), one NEEDS INPUT, one DONE, one idle, one unread, one on a cloud host (worktree chip). Timestamps are offsets from mount. | Hover shows the real toolbar; click selects (cyan); pin toggles locally; InboxViewMenu popover opens. |
| 2 | 9–15 | Conversation and steering | `desk` conversation pane | `ConversationHeaderBar` + `AgentStatusPill` (new), `ConversationMetadata` (canEditModel false, no id), `IdentityFace` (hover off), `ViewerFaces`, `UserPrompt`, `AssistantBlock` (ToolBlock Bash + Edit, `ThinkingBlock`), `InlineDiff` / `FileDiffView`, `WorkingStatusLine` (label written from the timeline), `ComposerShell` (new) | Prompt "retry failed webhooks with backoff", `bun test` output ("212 passed"), a small Edit diff | Composer typing driven by t; the Edit row can be expanded. |
| 3 | 15–21 | Multi-agent: fan out | `desk`, then flyers to `pairA` and `pairB` | `CastCommandBlock` (`cast spawn --subagent -- "..."`), `TaskToolBlock`, `SessionCardView` subagent compact rows, `SessionConstellation` | 2 workers: "Webhook API half" and "Dashboard retry UI" | Constellation `pulseKey` follows t; hovering a row lights its node. |
| 4 | 20–29 | Chat from the phone | `pairA` then `phone` | On the worker's pane its question, then Alex's answer and its reply (`AssistantBlock`, `UserPrompt`); on the phone the codecast iOS app's session screen in its dark theme: header, agent strip, the feed (`PhoneMessage`, `PhoneToolCalls`), the composer with its Needs Input then Working status (`PhoneComposer`), all in components/PhoneSession.tsx and read from `@codecast/shared/render/mobileSessionStyle`, the spec mobile/app/session/[id].tsx reads too, inside the iOS status bar and keyboard. | "Should a 410 Gone count as failed?"; "Agreed. Log 410s, never retry."; `npm test --workspace packages/api` | None beyond the views' own. |
| 5 | 28–34 | Multi-agent: talk and fork | `pairA` and `pairB` | `SessionMessageBlock`, `CastCommandBlock` (`cast send`), `EntityIdPill` via the fixture seam, `UserPrompt` with `forkChildren` | "API is on `/v2/hooks/retry`, schema in the doc" | Hovering the pill shows the real hover card with the fixture entity. |
| 6 | 34–40 | Decisions (cast decide) | `desk` side card | `DecisionCompactCardView` (new), `DecisionOptionList`, `DecisionAnswerControls` (keys=false), `DecisionRecordedAnswer` | "Exponential or fixed backoff?" with 3 options and cost tags | Clicking an option records it as the answer. |
| 7 | 40–47 | Work tracking | `board` | `TaskRow` + `KanbanCard` (moved), `ListRowShell` (new), `StationStrip`, `TaskStatusBadge`, `IssueLink`, `LabelChips`, `ActiveSessionBadge` (click cancelled), `PlanProgressBar`, `PlanGraphView` | The task is filed from chat, lands as a TaskPill, and is claimed by an agent; a plan with 3 waves | Clicking the status or priority cycles the fixture value (via ItemRowState); plan progress animates. |
| 8 | 47–53 | Automation | new `auto` surface (NE, beside the pair) | `TriggerRowItem` with `actions` (new), `SchedFireBadge`, `SchedHealthDot`, `ScheduledTaskBlock` (no trigger= attribute, or via the seam), `WorkflowGraphView` (theme forced, `chrome={false}`), `WorkflowRunNodes` (nodes without a session), `RunGate` (legacy gate_prompt only), `ThreadStatePanelView` (folded state passed in: a visitor's pref never reaches the hero) | "Check CI every 4h"; workflow implement → verify → review gate | Pause/Resume flips locally; nodes light up in order with t. |
| 9 | 53–61 | Team | new `team` surface (SE) | `ChatMessageList` / `ChatMessage` (fixtures from the _chatx.tsx pattern), `TypingIndicator`, `FaceRow` fed a `deriveFaceRow(fixtureInput)` model with callsEnabled=false, `FaceCircle`, `TranscriptTurnList`, `PresenceFacepile`, `CursorArrow`, `OrgGraph` with `ORG_FIXTURE` (or `StaffingPane` with `orgStaffingFixture`), `FeedCard` (onNavigate given, no shareTeamId) | An agent replies in #eng; a huddle caption line; the org chart has one role card that outlives its sessions | Reactions toggle locally; the summary more/less toggle; a teammate's cursor glides with t. |
| 10 | 61–68 | Integrations (GitHub, Linear) | new `pr` surface | `PRHeader` (actions={null}), `PRChecks`, `PRCommits`, `PrStatusChip`, `ExternalEventRow` (omitRefs), `IssueLink`, inside `.pr-page` + pr.css | PR #482, checks going from pending to green to merged | Check states flip with t. |
| 11 | 68–74 | Tools: publish and canvas | `page` | `AssistantBlock` holding a ```cast-canvas fence (a `HtmlSnippet` cast-chart), `PageCard` (exported) around a sandboxed srcdoc iframe of `brandArtifactHtml` (generated at build time) | A retry-rate report and 2 viewer comments | The real comments panel inside the iframe (fetch stubbed, `data:` metaUrl). |
| 12 | 74–81 | Capture and memory ("3 weeks later") | `palette`, then `blame` | cmdk `<Command filter={paletteItemScore}>`, `CommandPaletteList`, `PaletteSessionRow` / `PaletteSearchResultRow` (new, using shared `groupClass`/`itemClass`), `KeyCap`, `SearchResultRow` (new) with `highlightMatch`; `SessionBlameStrip` + `BlobView` (blameMode "session") + repo.css | A teammate types "webhook retry"; the blame ties `retry.ts:42` to the fork session | **Typing in the palette** filters fixtures through cmdk; hovering a blame chip lights its lines. |
| 13 | 82–89 | Surfaces: remote, cloud, browser | desk: the cloud worker's row opened from the right rail | `ConversationHeaderBar` with `TmuxAttachPill`, `AssistantBlock`, `CastCommandBlock` (`cast browser open`, open on mount via `defaultExpanded`), the row's host chip in `SessionCardView` | "linux-host-1" | none |
| — | 87.3–88.8 | seam | the desk, its content dissolving to t=0 (timeline.ts `SEAM_GHOST`) | none | none | none |

**Keeping it legible**

- Every hand-off between surfaces is a causal flyer, as in the current spec: spawn block to row, the worker's question to the phone, envelope to a "Message from" card, TaskPill to the board, a merged PR chip that turns into the page's version chip.
- The "3 weeks later" label marks the jump before chapter 12.
- Chapters 9 and 10 are new districts. Put them south-east and north-east so the camera loop stays a single orbit.
- Keep one hold of at least 3s per chapter.
- Each chapter's world is its own lazy chunk (section 1), so the longer film costs nothing until the camera heads there.

**Deliberately left out:** mail/whisk and iMessage (not codecast UI), `cast check`, capabilities, vault graph, calls CallStage, and anything tied to BrowserStream or TerminalPanel.

---

## 1. The sandbox mechanism

### Decision

- **Fixture data travels only as props into view components.** Nothing is written to the store.
- **A new `HeroSandbox` wrapper** (`app/(marketing)/heroFly/sandbox.tsx`) closes every remaining channel with one seam each:

```tsx
<HeroErrorBoundary fallback={<Poster/>}>             // failure stays in the hero, not MarketingPage's boundary
  <ConvexProvider client={heroConvexStub}>           // every useQuery/useQueries/useMutation/useAction/useConvex().query below
    <ThemeContext.Provider value={{theme:"light", visualStyle:"classic", ...}}>  // WorkflowGraphView, ActivityHeatmap, OrgGraph
      <PersonifyOverride.Provider value={false}>      // usePersonifyAll -> ignores the viewer's pref
        <EntityFixtureContext.Provider value={HERO_ENTITIES}>  // useEntityResolution answers from fixtures, all queries 'skip'
          <RevealInBandCtx.Provider value={true}>     // no reveal bands mounting the real RoutePane/SessionPane
            <div className="hero-sandbox" data-hero-sandbox
                 onClickCapture={cancelNav} onAuxClickCapture={cancelNav}
                 onDragStartCapture={prevent} onDropCapture={prevent}
                 onContextMenuCapture={prevent}>
              {world}
            </div>
```

### Pieces, file by file

1. **`app/(marketing)/heroFly/convexStub.ts`**
   - A plain object that implements what `convex/react` calls on a client:
     - `watchQuery` returns `{onUpdate: () => noop, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined}`.
     - `query`, `mutation` and `action` resolve `null`.
     - `connectionState`, `subscribeToConnectionState` and `prewarmQuery` are no-ops.
   - Result: every query stays in "loading" forever and never throws. No socket opens. The visitor's authenticated client is never touched.
   - `useConvexAuth` keeps reading the outer auth context, which is fine.
   - This single stub removes the whole class of "fixture id reaches prod" and "plain useQuery throws into ErrorBoundary" problems: EntityIdPill, castBlocks, RoleHoverCard, useStorageImageUrl, BrowserTabPill's prefetch, and the PermissionStack mutation if someone mounts it by mistake.
2. **`lib/entityDisplay.ts:170` (`useEntityResolution`)**
   - Read `useContext(EntityFixtureContext)` first. When set, pass `'skip'` to every query in the hook, skip `findEntityInStore(getState())`, skip `useSyncOrgProposal`, and return the fixture as `served`.
   - Route castBlocks' own direct queries through the same hook: `DocTitleLink` :57, `InlineEntityTitle` :82, `CastEntityCard` :104-106. That is also a reuse fix, because those three currently bypass the resolver.
   - `useOpenLinkedSession`: when the fixture context is present, return a no-op. It otherwise calls `syncRecord` on the real store (hooks/useOpenLinkedSession.ts:64-72).
3. **`hooks/usePersonifyAll.ts`**
   - Consult a `PersonifyOverride` context before the store.
   - One seam covers SessionGlyph, SessionIdentityLine, IdentityFace, EntityIdPill and NotificationRow, so the per-component `personifyAll` props become unnecessary.
4. **`components/ThemeProvider.tsx`**
   - Export `ThemeContext` (it is module-private at :17).
   - Theme lock, described in section 4.
5. **Navigation cancel**
   - `cancelNav` calls `preventDefault()` on any `a[href]` click. The compat Link honours `defaultPrevented` (src/compat/next-link.tsx:17-18).
   - It also calls `stopPropagation()` for elements not marked `data-hero-live`.
   - Handlers the hero owns (Approve, option pick, pin, cmdk input) carry `data-hero-live`.
6. **Mount policy (a rule, enforced by the test in item 7)**
   - Never mount a component that adds `window` or `document` listeners that act, runs a feeder, or calls a store action:
     - PermissionStack (global y/n listener)
     - ForkMapBox (capture keydown)
     - BrowserPane
     - DecisionAnswerControls with keys=true
     - GenericListView (shortcut registration)
     - GlobalSearch (`search.open`)
     - CommandPalette
     - NotificationBell (feeder)
     - DocumentDetailLayout in edit mode (Cmd+E and CollabDocEditor)
     - MessageInput, ChatComposer, RoomThread (they persist drafts)
     - TriggerRowItem without the `actions` override
7. **Guard test: `app/(marketing)/heroFly/sandbox.guard.test.tsx`** (bun + jsdom)
   - Mount `<World>` inside `HeroSandbox` with the real store module imported.
   - Step `frame(t)` across the whole timeline and fire every `data-hero-live` interaction.
   - Assert:
     - (a) every top-level store key is reference-equal before and after;
     - (b) spies on `_setIDBWrite`, the outbox enqueue and the dispatch show zero calls;
     - (c) `window.addEventListener` and `document.addEventListener` were called only for types on an allowlist;
     - (d) a spy on the real `ConvexReactClient.prototype.watchQuery` shows zero calls;
     - (e) `document.documentElement.className` is unchanged by hero code;
     - (f) `localStorage.setItem` was not called.
   - This is the proof of isolation, and it catches the next person who drops a container into the hero.

### Prerender

- The landing page is prerendered with `renderToString` (src/prerender-entry.tsx:24, `import Landing`).
- `useTrackedStore` has no `getServerSnapshot` (inboxStore.ts:12956), so any view that still reads the store throws under SSR.
- Plan: the view modules for the **poster chapter (1, desk inbox plus the conversation prompt)** are kept free of the store module. A `bundleGraph`-style guard test walks `heroFly/poster.tsx` imports and fails if `store/inboxStore` is reached. The poster at `POSTER_T` is then the real product, prerendered.
- Every other chapter is its own chunk. The conversation (the other half of the poster) is requested as soon as the hero's code loads, because it carries the app's whole transcript renderer (turnBlocks and the tool, system, cast and interactive blocks); the film fades in once it lands. The rest load on idle and mount one per idle callback, each once the film is within two chapters of it. Crawlers get the prerendered inbox; the sr-only description carries the story.
- A one-line product-safe addition is also worthwhile: `getServerSnapshot: () => useInboxStore.getInitialState()` in `useTrackedStore`. It makes any accidental SSR reach render the initial state instead of throwing.
- Importing the store under SSR is safe: `bootPersistence` is gated on `typeof window`. This still needs verifying with `scripts/prerender.mjs`.

### Why not the alternatives

- **A store context seam** covers the 3 read hooks but not the 229 imperative `useInboxStore.getState()` sites or the actions inside the store config. Clicks would still write the real store.
- **Seeding the real store** leaks to IDB and the outbox.
- **The dev preview module swap** (vite.preview-migrate.config.ts) is not usable on a live route.
- **Fallback, only if a whole container must ever be mounted:** a second Vite production entry served from a separate origin (e.g. `hero.codecast.sh`) in an iframe. In that realm the real store is its own singleton and storage is isolated structurally. It needs a sandbox flag that skips `bootPersistence`, `persistPendingMessageChanges` (mutativeMiddleware.ts:373), the prefs localStorage writes (:310, :332) and the gesture channel (`setGestureChannelFactory(() => null)`, gestureBridge.ts:128), plus `_setDispatch(async () => null)`. Cost: 1 to 2 days, no prerender, and a full-app download. Nothing in the scene list needs it.

---

## 2. What each surface mounts, and the fixture shapes

All ids look like `hero-*` (not Convex-shaped). All timestamps are `mountNow - offset`. Relative labels that must follow the scrubbed timeline (the working clock, "N ago") are written from `t` instead.

- **Inbox (chapters 1 and 3):**
  - Fixture: `InboxSession` (inboxStore.ts:497) with `_id`, `title`, `agent_type`, `agent_status`, `agent_status_updated_at`, `last_heartbeat`, `producing_until` (future), `message_count > 0`, `thread_state` + `thread_state_status`, `idle_summary`, `last_user_message`, `worktree_name`, `pr_status`, `git_root`/`project_path`, `is_subagent`, `is_pinned`.
  - Leave unset: `role`, `is_anchor`, `owner_device_id`, `assigned_ping`, `open_comment_threads`, `image_preview_url`, git remote. A `spawned_by` title is fine; the view takes it as a prop.
  - Plus a `CardChrome` fixture: `{showAgentIcon: true, showBranchPill: true, showModelBadge: false, imageThumbs: false, personify: false}` and `viewer: {userId: "hero-me", teamMembers: [], roster: [], anchors: []}`.
- **Conversation (chapter 2):**
  - `ToolCall {id, name, input: JSON}`, `ToolResult {tool_use_id, content, is_error?}`, `ImageData {media_type, preview_url}` (same-origin), per conversation/types.ts.
  - Blocks get **no `conversationId`**, no `isPending`, no `storage_id`, and no fork/share callbacks.
  - Header: `{title, status: "working"|..., agentType, model, startedAt, messageCount, viewers: FacePerson[]}`.
- **Chat (chapter 4):** the worker's question, Alex's answer and its reply as `AssistantBlock` and `UserPrompt` rows in the worker's pane, and the same three messages in the phone's session screen (fixtures/phone.ts), drawn from the shared RN style spec.
- **Multi-agent (chapter 5):**
  - `SessionMessageBlock {from: "jx7c4mq", name, body, timestamp}`, with no `pendingStatus`.
  - `HERO_ENTITIES` maps `jx7c4mq`, `ct-4182` and `pl-312` to entity rows shaped like the webGet returns.
  - `cancelNav` hides the jump button's effect.
- **Decisions (chapter 6):** a `SessionDecisionItem` plain object with `kind: "single"`, `question`, `options: DecisionOption[]`, `context`, `session_title`, `project_path`. Omit `workflow_run_id`, `report_slug`, option page slugs, `task_id` and `stack_id`.
- **Work (chapter 7):**
  - `TaskItem` with no `team_id` (so the default statuses apply), `assignee_info: {name}` with no image, `origin_session {...}`, `updated_at`.
  - A local `ItemRowState`.
  - `PlanGraphView` tasks carry `depends_on`.
  - `StationStrip` gets `status` and no `workflow_run_id`.
  - Rows sit inside a `.cq-container` whose layout width is at least 900px. The world scale does not change layout width, so the `cq-hide-compact` columns survive.
- **Automation (chapter 8):**
  - `TriggerRow {task: TaskRow(triggerTasks.ts:26), unread: false}` plus `actions`.
  - WF nodes/edges per WorkflowGraphView.tsx:22,36, and `nodeStatuses`/`currentNodeId` from t.
  - `run.node_statuses[]` per lib/workflowRun.ts, with no `session`.
- **Team (chapter 9):**
  - `ChatMessageView[]` (chat/chatTypes.ts): no attachments, no `call`, `mentionRefs` for pills.
  - `deriveFaceRow(FaceRowInput, null)` (faceRow.ts:473).
  - `Turn[]` via `groupTurns`.
  - `ORG_FIXTURE` inside a fixed, untransformed inner box with `pointer-events: none` on role cards.
  - FeedCard `conv` with `author_avatar: null`.
- **Integrations (chapter 10):** a PR row (`repository`, `number`, `state`, `title`, `head`/`base`), `PrCheck[]`, commits, `ExternalEvent` without task refs.
- **Publish (chapter 11):**
  - A canvas HTML string.
  - `public/hero/page.html` generated at build time by `scripts/hero-page.ts`, which calls `brandArtifactHtml(reportHtml, opts)`. The opts use a `data:` metaUrl, a dead apiBase, and a prepended fetch-stub script for POSTs.
- **Memory (chapter 12):**
  - Palette rows use `IdentityRow` + `title` + `bucket`.
  - Search results use `{session, snippets: [{role, text}]}`, highlighted with `highlightMatch(getSnippet(text, q), q)`.
  - Blame: `SessionBlameRange[]` fed through `summarizeSessionBlame` and `sessionBlameColors` (lib/repoView.ts); the sessions have no `href`.

---

## 3. Refactors in the app (container/view splits; each is a move with no behaviour change)

Order: poster first, then by leak severity.

1. **`components/inbox/SessionCardView.tsx`**
   - Move the JSX of `SessionCard` (GlobalSessionPanel.tsx:1952-~3050) into a view that takes `session`, `chrome`, `viewer`, `liveness` (blockedRevive, pending, restarting, draft), `spawnedByTitle`, `author`, `viewers`, plus handler props: `onToggleFavorite`, `onOpenLabels`, `onAckAssignment`, `onOpenComments`, `onOpenParent`, `onPaneDragStart`, `onDropFiles`, and the existing `on*` props.
   - `components/inbox/SessionCard.tsx` becomes the container: the single `useTrackedStore` at :2030, the two `useMutation`s, `useAckAssignment` and the getState actions. It renders the view. GlobalSessionPanel imports it.
   - This also takes about 1.1k lines out of a 5.2k-line file.
   - Also extract `SectionHeader` from the `renderSection` closure (~:4499).
2. **Theme lock** (ThemeProvider + MarketingLayout + ForceLightMode). See section 4.
3. **`PermissionStackView`** (PermissionCard.tsx)
   - Export the JSX from :222-349 plus `PermissionRow` and `ToolName` as a view: `{pending, inflight, onApprove, onDeny, onApproveAll, onDenyAll, onAllowAll?, collapsed, expandedId, ...}`.
   - `PermissionStack` keeps the mutation (:121), `resolveSessionQuestion` (:122) and the y/n listener (:185).
4. **Entity, personify and ThemeContext seams** (section 1, items 2 to 4). Also route castBlocks' queries through `useEntityResolution`.
5. **`ConversationHeaderBar` + `AgentStatusPill`** from ConversationView.tsx:3632-3990. This also collapses the status ternary that is repeated four times (~3693-3735).
6. **`ComposerShell`** from MessageInput.tsx (~2620-2700 plus the meta line at 2177): `{value, onChange, placeholder, canSubmit, onSubmit, meta, actions}`. MessageInput keeps the drafts and send.
7. **Sidebar primitives**
   - Move `RailHeading`, `SectionRow`, `NavCount` and `NavSection` (Sidebar.tsx:99-376) to `components/sidebar/navPrimitives.tsx`.
   - The rail's three groups are `SidebarNavView` (`components/sidebar/SidebarNav.tsx`), with the rows that read live counts as views beside it (`ThreadsNavRowView`, `FeedNavRowView`, `QuestionsNavRowView`, `ChatNavSectionView`); Sidebar feeds it from the store, the hero from fixtures.
   - Extract `InboxNavRow({active, count})` from :1282-1306.
   - Extract `SearchField({value, expanded, onChange})` from GlobalSearch.tsx:255-330.
   - Extract `SearchResultRow` from GlobalSearch.tsx:395-455 and share it with app/search/page.tsx.
8. **Palette**
   - Move `groupClass` and `itemClass` (CommandPalette.tsx:2317-2318) to `components/paletteStyles.ts`.
   - Add `PaletteSessionRow` (:2860-2918) and `PaletteSearchResultRow` (:2940-3010).
9. **Tasks and docs**
   - Move `TaskRow`, `KanbanCard`, `PRIORITY_CONFIG` and `SubtaskRing` into `components/tasks/TaskRow.tsx`.
   - Add `ListRowShell` from GenericListView.tsx:1100.
   - Move `DocRow` into `components/docs/DocRow.tsx` with an `onStar` prop.
   - Export `DOC_MD_COMPONENTS` and `DaySection`.
   - This stops the hero chunk from pulling in the tasks and docs page modules.
10. **Decisions:** `DecisionCompactCardView({decision, session, task, stack, now, onAnswer, onDismiss, onJumpToAsk})`.
11. **Triggers:**
    - Add an optional `actions` to `TriggerRowItem`, defaulting to the store's `triggerAction`.
    - Export `TriggerPill` and `SingleHeader` from TriggerContextPanel.
    - Export `HorizonRail`.
12. **Workflow:** add an optional `chrome` prop (default true) that hides `Controls` and `MiniMap`. Theme comes through `ThemeContext`.
13. **Mobile parity:** the phone's session screen reads the same spec as the app's (`@codecast/shared/render/mobileSessionStyle`, read by mobile/app/session/[id].tsx and components/PhoneSession.tsx).
14. **Smaller exports:** `PageCard` (PublishedPageEmbed.tsx:84), `NotificationList` from NotificationBell, and `RecapCard`, `PassageBlock` and `ChatLine` from RoomThread.

**Verification for each split**

- Run `cast check web`.
- Run the existing tests for the file (e.g. the GlobalSessionPanel and PermissionCard tests).
- For SessionCard, compare `renderToStaticMarkup` before and after on a set of fixture sessions. The markup must be byte-identical.

---

## 4. Theme and CSS

**What is broken today** (this is invisible now only because the mocks use hex colours):

- **Dark users get the dark theme on the landing page.** ThemeProvider renders null until mounted (ThemeProvider.tsx:90). In the commit that mounts MarketingLayout, `ForceLightMode`'s effect (child) runs before ThemeProvider's `[theme, mounted]` effect (parent, :50-56), which re-adds the stored theme. It re-adds it again on every `clientState.ui.theme` sync. This is traced from the code; a browser check should confirm it.
- **Minimal-style users keep minimal-style.** ForceLightMode never strips it (:77). globals.css has **299 `.minimal-style` descendant rules**, so a CSS-variable scope on the hero alone **cannot** undo it. The fix must remove the class from `<html>`.
- **The user-bubble hue is set on `<html>`** from the viewer's prefs (:45), which tints UserPrompt bubbles.
- **`.light` defines no variables.**

**Root-cause fix**

- Add a lock: `useThemeLock("light")` in ThemeProvider, registered by MarketingLayout in place of `ForceLightMode`. While the lock is held, ThemeProvider's own effects apply `light`, remove `minimal-style` and `codex-style`, and skip the bubble hue. On release they restore the stored state.
- This removes the effect-order race, because the class writes now have one owner.
- `ThemeContext` then reports `{theme: "light", visualStyle: "classic"}` on marketing, so `WorkflowGraphView`, `ActivityHeatmap` and `OrgGraph` follow it without a hero override. The sandbox provider stays as a second layer.

**Inside the hero**

- Change `:root {` to `:root, .hero-sandbox {` on the light token block in globals.css. There is one token list, no copy. Local variables then win over anything inherited.
- Add `color-scheme: light` and a `--image-fade-bg`.
- **Phone:** wrap it in `<div className="dark">`. `.dark` is a class selector, so every `--sol-*` switches locally. The 9 `dark:` utilities in the target files also resolve correctly under that ancestor. The dark phone beside the light desk is a deliberate choice: the iOS app follows the system theme, so both are the app as it renders, and a dark screen in its bezel reads at once as a separate device on the cream page, where a light one would read as another pane of the desk.
- **Page-scoped CSS the hero must import:** `components/editor/editor.css`, `components/pr/pr.css`, `components/repo/repo.css`, `chat.css`, `decisions.css`, `calls/faces.css`, `CommandPalette.css`, and `@xyflow/react` styles, which WorkflowGraphView already imports. Load them in the lazy chapter chunks so the poster stays light.
- **Background mismatch:** the page paints `#fdf6e3` but `--sol-bg` is `#FBF5E2`. Set the stage backdrop to `var(--sol-bg)` or accept the difference.
- **Accent classes** (text-sol-blue and similar) are hardcoded hex, which is correct for light.
- **Portals** (Radix tooltips and popovers, the InboxViewMenu popover, EntityIdPill hover cards, the fork preview) render flat at `document.body`, outside the 3D plane, where they cover the page, do not follow the camera, and take the page's Escape and outside clicks.
  - Hover never opens one: the sandbox provides `HoverCardsOff` (`lib/hoverCardsOff.ts`), which `useHoverCard`, the Radix `TooltipContent` and `BranchSelector`'s fork preview read. `sandbox.guard.test.tsx` points at every element at each hold and waits out the hover delays.
  - Portalled content sits outside `.hero-sandbox`, so it inherits `<html>`'s tokens. The theme lock is what keeps those correct.

---

## 5. Light interactions: cheap and safe

All of these are local `useState` with `data-hero-live`, and none depend on real handlers.

**Cheap and safe once the splits land:**

- Picking a decision option (`DecisionOptionList` / `DecisionAnswerControls` with keys=false).
- Typing in the palette: cmdk plus the pure `paletteItemScore`. Do not autofocus, and only listen while the input is focused, so the page's keys are never taken.
- Hover and select on session rows, and local pinning.
- The `InboxViewMenu` popover.
- Blame chip hover and pin.
- Chat reactions.
- FeedCard more/less.
- Task status and priority cycling via `ItemRowState`.
- Trigger Pause/Resume via `actions`.
- The TaskTimeline filter.
- Expanding ToolBlocks. This touches only the non-persisted `diffViewerStore`; accept that, or cancel it.
- The published page's comment panel inside the sandboxed iframe.

**Keep non-interactive (`pointer-events: none`):** OrgGraph and WorkflowGraphView (d3-zoom hit-testing is wrong under a 3D transform), FaceRow seats (hover opens FaceCard, which reads the real roster), SharePopover, and PlanTaskSection/PlanBoardView until their callbacks become props.

**Global keys:** none. The hero adds no `window` or `document` key listeners. The guard test enforces this.

---

## 6. Risks, ranked

1. **A container gets mounted in the hero later and writes the store or outbox.** The fixture write then ships silently the next time the visitor opens `/inbox`. Mitigated by the split-only rule, the stub Convex provider, and `sandbox.guard.test.tsx` (store reference equality, IDB/outbox/dispatch spies, listener allowlist).
2. **Theme is wrong for signed-in dark and minimal users.** The 299 minimal-style rules defeat a variable-only scope. Only the ThemeProvider lock fixes it. Verify in the browser as a dark user and as a minimal user by reading `document.documentElement.className` on `/`.
3. **Entity pills show a signed-in visitor's real rows** (`ct-1`, `jx7…` prefixes). Fixed by the `EntityFixtureContext` seam. Until it lands, keep id-shaped strings out of every fixture text.
4. **Prerender breaks** (`useSyncExternalStore` without `getServerSnapshot`, a larger SSR graph). Mitigated by the store-free poster modules plus the import-graph guard, lazy client-only chapters, and `getServerSnapshot`. Run `scripts/prerender.mjs` in CI.
5. **SessionCard split regressions** in the product's busiest component. Mitigated by the markup snapshot equality test and running the full inbox test file.
6. **Portals and ReactFlow under 3D transforms** (misplaced popovers, wrong fitView, broken hit-testing). Mitigated by hold-only portals and fixed-size untransformed inner boxes for ReactFlow.
7. **Bundle weight for anonymous visitors** (react-markdown, highlight, xyflow, cmdk, Plot). Mitigated by per-chapter lazy chunks prefetched on idle, the brandArtifactHtml page generated at build time, and moving SessionCard out of GlobalSessionPanel.
8. **Clock drift.** `useCoarseNow`, `formatRelativeTime` and `ThreadStatePanel`'s staleness cutoff read wall time. Fixture offsets are taken at mount, and labels that scrub are written from t. ThreadStatePanel disappears if its `threadStateAt` is stale.
9. **Real-UI churn breaks the film.** This is intended, since the film tracks the product. Add a Playwright seek-capture per chapter (`?hero-t=`) so visual regressions are caught on review, not by visitors.
10. **Shared Cache Storage.** AvatarImg writes to `codecast:avatars:v1`. It is harmless, but use null or same-origin avatars.

**Key files**

- Existing hero: `/Users/ashot/src/codecast/packages/web/app/(marketing)/HeroFlythrough.tsx`, `/Users/ashot/src/codecast/packages/web/app/(marketing)/heroFly/{surfaces.tsx,timeline.ts,world.ts}`, `/Users/ashot/src/codecast/packages/web/app/(marketing)/heroFlythrough.spec.md`, `/Users/ashot/src/codecast/packages/web/app/(marketing)/productMocks.tsx`
- Store: `/Users/ashot/src/codecast/packages/web/store/inboxStore.ts`
- Seams: `/Users/ashot/src/codecast/packages/web/lib/entityDisplay.ts`, `/Users/ashot/src/codecast/packages/web/hooks/usePersonifyAll.ts`, `/Users/ashot/src/codecast/packages/web/components/ThemeProvider.tsx`, `/Users/ashot/src/codecast/packages/web/components/force-light-mode.tsx`, `/Users/ashot/src/codecast/packages/web/src/layouts/MarketingLayout.tsx`
- Prerender and tokens: `/Users/ashot/src/codecast/packages/web/src/prerender-entry.tsx`, `/Users/ashot/src/codecast/packages/web/app/globals.css`