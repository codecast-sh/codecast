---
version: 1
slug: "src-layouts-dashboardshell-tsx"
primary_target: "src/layouts/DashboardShell.tsx"
related_targets: ["components/ConversationView.tsx","app/globals.css"]
---

# Signed-in workspace (whole app shell and pages)

Scope: every signed-in route in packages/web (inbox, conversation, decisions, chat, tasks, docs, calls and the routes under More). Marketing pages are out of scope and keep their layouts. Visitor mode: Operate.

Audience and job: engineers and leads who each run many agents, in Codecast all day. They see what waits on them, open a session, read, answer or steer, and move on, mostly by keyboard.

Constraints: no data-contract changes; one style in light and dark; color-theme picker stays with retuned palettes; nav cut to six daily surfaces plus More, with no route deleted.

## Direction contract

THESIS: Codecast as a Linear, Slack and Superhuman-grade workspace: one calm neutral system where only what waits on you carries colour. It refuses the incumbent mono, badge-dense, twenty-item-nav dashboard and any themed costume.

OWN-WORLD: Neutral greys. Light: #ffffff work area, #f7f7f8 sidebar, #e6e6e8 hairlines, #18181b ink, #71717a secondary. Dark: #0f0f11 ground, #141417 sidebar, #17171a panels, #26262b hairlines, #ededef ink. One indigo accent (#5e6ad2, dark #7c86e8) for selection, the primary action and "needs you". Red, amber and green only for real state. A neutral UI sans at 13/14px with 12px meta and 15/18/22 headings; mono only for code and short IDs. 6px radii, hairline borders, shadows only on popovers, 16px stroke icons.

STORY: Opening the app shows what waits on you first. Open a session, read it, answer it, move on with j/k. Everything else is one click under More or one ⌘K away.

FIRST VIEWPORT: 220px sidebar with the workspace switcher, Inbox, Decisions, Chat, Tasks, Docs, Calls, More, and the workspace list with each folder in its workspace colour. The account menu stays the avatar at the top right, Slack's convention (the owner's waiver, 2026-11-11: one home for the account, no second copy in the sidebar). The inbox list is grouped Needs you / Working / Done, and each row leads with the session's mark (a tile in its workspace colour with the agent inside, or its face) and has three lines: title; summary; ID · project · agent · machine with the time on the right. The conversation detail has a slim header (title, ID, quiet meta), messages and inline decision cards with an indigo border, and the composer docked at the bottom.

FORM: The category standard (canon, the user's choice over the roll after one re-roll), held to Linear, Slack and Superhuman craft. Signature interaction: keyboard triage, where selection moves instantly with a crisp indigo edge and one-key actions show their shortcut hint on hover. Motion grammar: 120–160ms ease-out for hover and selection, 180ms for panel slides, nothing on entry. seed:c63f3d75f81679c4

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
