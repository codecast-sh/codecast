# Archive

Plans, specs and roadmaps whose work has shipped or been replaced. They stay for the reasoning
behind the design. Every file opens with a dated status line; the body is the original record and
is not kept current, so unticked checkboxes inside them say nothing about what exists.

| Doc | Status (2026-10-04) | Current reference |
|---|---|---|
| [plans-roadmap](plans-roadmap.md) | Shipped, mostly: 24 of 37 items done, 12 partly, 1 not done. Phase 5 "daemon mode" became `cast trigger` and workflows | [orchestration-guide](../orchestration-guide.md) |
| [roadmap-diff-viewer](roadmap-diff-viewer.md) | Shipped: 19 of 21 items, in `ConversationDiffLayout.tsx` | [pull-requests](../architecture/pull-requests.md) for the PR half |
| [mobile-web-parity-roadmap](mobile-web-parity-roadmap.md) | Partly shipped: 17 of 31 done. Search, activity feed, explore and the palette were never built on mobile, and the app's tabs have since changed | None; a parity effort needs a fresh list |
| [handoff-2026-07-30-sync-cutover-addendum](handoff-2026-07-30-sync-cutover-addendum.md) | Superseded: the v2 sync layer it hardens was removed on 2026-08-05 | [sync-log-migration](../architecture/sync-log-migration.md), [sync-host](../architecture/sync-host.md) |
| [plans/2026-03-14-team-scoped-workspaces](plans/2026-03-14-team-scoped-workspaces.md), [spec](specs/2026-03-14-team-scoped-workspaces-design.md) | Superseded: "personal is a null `team_id`" was replaced on 2026-08-14 by the stored `workspace` access key | `CLAUDE.md`, "Workspace access vs routing" |
| [plans/2026-03-16-activity-feed-hierarchy](plans/2026-03-16-activity-feed-hierarchy.md), [spec](specs/2026-03-16-activity-feed-hierarchy-design.md) | Partly shipped, then superseded: tiered cards landed, the day narrative was removed on 2026-07-23 | [changes-page](../proposals/changes-page.md) |
| [specs/2026-03-16-data-context-layer-design](specs/2026-03-16-data-context-layer-design.md) | Shipped: `createDataContext` in `packages/convex/convex/data.ts`; access now reads the `workspace` key | `CLAUDE.md`, "Workspace access vs routing" |
| [plans/2026-03-18-vite-migration](plans/2026-03-18-vite-migration.md) | Shipped on 2026-03-18. The desktop app is Electron, not Tauri as the plan says | [CONTRIBUTING](../../CONTRIBUTING.md) |
