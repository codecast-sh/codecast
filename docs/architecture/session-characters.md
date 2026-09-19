# Session characters

Every session in codecast wears a character: one of the 24 painted animal
faces from the role avatar set (org-staffing.md S13) and a short name. A list
of sessions then reads like a room of people rather than a column of titles,
and a face the eye has learned once finds the same thread again in the inbox,
the tab strip, a mention in chat, the org chart and a decision card.

## S1. What a character is

A character is a pair: `avatar` (a key from `shared/contracts/orgAvatars`)
and `name` (up to 24 characters, one line). Both live on the conversation:

```
conversations.character_avatar?: string   // an avatar key
conversations.character_name?: string     // a person's name for the session
```

Either may be set alone. Whatever is not set falls to the default.

**The default is stable and costs nothing.** A hash of the conversation id
picks the face, and a second slice of the same hash picks the name from a
bank of six names per face (`shared/contracts/sessionCharacter.ts`,
`CHARACTER_NAMES`), so a new session is one of 144 characters the moment it
exists, identical on every device and surface, without anyone choosing. The
bank is curated: short, whimsical, never a name that reads as a teammate's,
and no name shared between two faces, so a name alone identifies the face.

**A role's standing session wears the role.** When a conversation is a role's
standing session (`standing_role_id`), its identity is the role's: the
role's avatar, the role's display name and its `@handle`. The character
fields are ignored on that row; the role is the identity and the session is
its current body, so retiring and reseating a role keeps the face. A hand
filed under a role (`org_role_id`) keeps its own character and says who it
reports to in its hover card.

`sessionIdentity(row)` (web `lib/sessionIdentity.ts`) is the one resolver
every surface calls: it returns `{ kind: "role" | "character", avatar, name,
handle?, roleShortId? }`. No surface reads `character_*` or the role fields
directly.

## S2. Choosing

The default flow is one gesture. Click the face anywhere it is interactive
(the inbox card, the conversation header) and the character picker opens: a
grid of the 24 faces, the name field prefilled, and a shuffle button that
proposes another name from the bank for the selected face. A click on a face
applies at once, optimistically, through the store's `setSessionCharacter`
action on the generic conversation patch rail (`conversationFields.ts` marks
both fields `send`, `dispatch`, `patch`); there is no save button. "Use the
default" clears both fields.

The picker is also reachable from the session context menu ("Character…"),
the command palette ("Change character"), and the keyboard shortcut
`session.character`. Typing a name and pressing Enter keeps the face.

The list owns ONE picker for every card, the way it owns one right-click menu:
a popover per row would mount one per card. Both gestures resolve their targets
through the same `selectionTargets` helper, so they cannot disagree about what
"this card" means when a selection is ticked. The picker is a
`CursorPopover` rather than the `ContextMenu`, because a dropdown owns arrow
keys and typeahead for menu navigation and would fight the face grid's roving
tabindex and the name field.

**Many at once.** With several sessions ticked, the selection bar and the
bulk context menu offer "Character for N sessions". The same picker opens
with a footer switch: *one face for all* (a squad reads as a squad) or
*a different face each* (the picker assigns distinct faces and default
names). The bulk write is one store action over all ids, one dispatch.

Names are the person's: the title generator never touches `character_name`,
and a role seat rename (S16) never touches it either.

## S3. Where it renders

One component family under `components/identity/`:

- `SessionFace({ row, size })` draws the face. A role's face carries a thin
  violet ring, the org page's role colour, so a role reads as a role at every
  size from 14 px; a character has no ring.
- `SessionIdentityLine({ row })` is the card line: the face, the name in
  medium weight, then the title in the secondary text colour, separated by a
  colon. `Ember: Fixing the auth race`. The name never truncates; the title
  does. For a role the line is the role name and, muted, its `@handle`; the
  title is not repeated when it equals the role name (a standing session's
  title is the role's name, S16).
- `SessionGlyph({ row, size, fallback })` is what a LIST calls: the face when
  the row is personified, and whatever mark the surface drew before it when
  nobody opted in. One call site per list, so the palette, the search page, the
  tab strip, a task's linked sessions and a decision's asking session cannot
  drift apart on when a face appears.
- Hovering a face, a name or a session pill opens the hover card (S4).

Surfaces, and the size the face takes:

| surface | size |
|---|---|
| inbox card, threads card, fleet tile | 18 |
| inbox subagent and trigger child rows, sidebar rows, tab strip, window taskbar | 14 |
| conversation header | 22 |
| session reference pill (`jx7abcd`) | 1em, replacing the type icon fallback |
| command palette rows, global search, search page, task linked sessions, decision cards, feed cards | 16 |
| org chart session card | 20 |
| notification rows | 20 on the session chip |
| mobile session row | 20 |

The agent brand does not get a glyph of its own on the card any more: it rides
the face as a small corner badge, so one mark answers "who" and "which agent"
without two glyphs competing in the title row. The badge follows the existing
`show_agent_icon` preference and is dropped under 16 px, where it would only be
a smudge. The generic anchor glyph is gone: a role's ringed face says which
role, which is strictly more than "this is a standing agent".

## S4. Hover cards: who they are and what they do

One hover primitive (`components/ui/HoverCard.tsx`, lifted out of the
reference pill: 200 ms in, 150 ms out, a bridge over the gap, content that
re-arms on enter) serves every session and role hover in the app.

**A session's card** answers who and what in four lines: the face at 36 px
with the name and, dimmed, the title; the agent and model; the owner and
machine; the pinned state line or the last activity. A hand under a role adds
"reports to @handle" with the role's small face.

**A role's card** answers who they are and what they do. The face at 36 px
with the violet ring, the display name, `@handle` and a chip for status and
tenure (standing, or program with what ends it). Then the charter in one or
two sentences (the charter doc's first paragraph, else the inline charter).
Then the scope as chips: projects and plans, or "whole workspace". Then
reports to, trust level, and today's use against caps. A footer link opens
the scope page. The card reads from the org tree slice when it is loaded and
from `org.roleCard` otherwise, through `useQueryNoThrow`, so a missing answer
leaves a face and a name rather than an error.

Role hover attaches wherever a role is named: the inbox card of its standing
session, the conversation header, the chat role pill, the wake card header,
the proposal author pill, the org chart node, the ownership menu.

## S5. Roles in the inbox

A role's standing session sits in the inbox for a reason: it needs input, it
finished a wake, it is dormant until its next one. The card keeps that reason
where it is today (the state chip and the pinned line) and changes only who
it says is speaking: the role's face with its ring, the role's name, its
handle. What the role does is one hover away, never on the card. That is the
balance: the inbox stays a list of things that need a person, and identity is
recognised rather than read.

## S6. Guard rails

- `sessionIdentity` is the only reader of `character_*`, `standing_role_id`
  and the row's `role` snapshot; a source level test fails any other reader
  under `components/` or `app/`.
- The inbox row carries `character_avatar`, `character_name`,
  `standing_role_id`, `org_role_id` and, for a role's rows only, a `role`
  snapshot `{ short_id, name, handle, avatar, status }`; the projection guard
  test lists them.
- The name bank test: six names per face, all distinct, capitalised words.

## S7. On the phone

The mobile app draws the same characters from the same sources. It imports
`sessionIdentity`, `identityLine`, `faceIdentity` and `identityRowOf` from
`packages/web/lib/sessionIdentity.ts`, and the 24 WebP files from
`packages/web/components/org/avatars/`. Metro bundles those files as assets,
so there is one copy of the art and one resolver for both clients.

`packages/mobile/components/identity/` holds the React Native drawing:

- `MobileSessionFace` always draws a face, with the role ring and the agent
  badge. It is an `Image`; it does not draw through `react-native-svg`.
- `MobileIdentityFace` is the phone's `SessionGlyph`: the face when the row is
  personified, else the mark the surface drew before.
- `MobileSessionIdentityLine` leads with the name and dims the title.
- `useSessionIdentityRow` and `useSessionIdentityLookup` subscribe to
  `identitySig`, never to a row, because the inbox list's wake signature leaves
  the character fields out.

Faces render on the inbox row, the session header, chat lines a session typed,
the session reference pill, inbox search results and session notifications.
The chat mention strip offers people only, so it has no session to draw; the
phone has no character picker yet, so choosing a face is done on the web.

The phone's guard rails: `components/identity/identity.test.tsx` renders every
key and fails any import in that folder outside React Native, the app and the
shared packages; `metro.config.test.cjs` proves every module on the face path
resolves the app's one pinned `react-native-svg`; `scripts/audit-export.mjs`
checks an exported bundle for one copy of each native library and all 24 files.
