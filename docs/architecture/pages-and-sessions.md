# Cast pages and sessions

A cast page is an HTML file, a directory or a markdown file that an agent session publishes to `codecast.sh/a/<slug>`. It starts as a report the agent wrote and can grow into an app that people use while the agent keeps working on it. This doc describes how a page and a session are connected today, and where that connection is weak.

## What a page is

`cast publish <file|dir>` uploads the file and prints a stable URL for that path. Publishing the same path again adds a version under the same URL. Versions can be viewed (`?v=N`), diffed (`?diff=A..B`) and rolled back. A page is unlisted and open to anyone with the link unless it has a password, an email gate, a team gate or an expiry.

A page can be any of these, all served the same way:

| Kind | What makes it one | Where the data comes from |
|---|---|---|
| Report or mockup | Static HTML or markdown | The file itself |
| Dashboard | `queries` in `cast-data.json` | Readers (`tasks`, `sessions`, `usage`, `prs`, `signals`, `events`, `metric`, `hogql`, `connector`) run as the publisher, refreshed on view |
| App | `state` in `cast-data.json` | Collections of rows that viewers and sessions read and write live |
| Desktop app | `app` in `cast-data.json` | Any of the above, installed with its own window, tray item and permissions |

## Five ways a page and a session are connected

### 1. The session publishes and republishes

The session that published a page owns it (`artifacts.session_conversation_id`). Every republish is a new version, and open copies reload when it lands. `cast publish --watch` republishes on every save, and viewers on `?live=1` reload without asking.

### 2. The page shows up in the conversation

A page URL alone on a line in the session's reply embeds the live page at the width of the conversation, 420px tall or the height the page declares with `<meta name="codecast:height">`. Inside a sentence it renders as a titled pill. `--task ct-N` also attaches the page to a task as evidence.

### 3. The page shows that the session is working

The publish bar carries an agent chip, fed by `artifacts.agentStateBySlug`. It reads the publishing session's work state (`classifyNamedWorkState`), so viewers can see that the agent is working, idle, or has a sent comment that no newer version has answered yet. Only a new version counts as an answer.

### 4. Comments go to the publishing session

A viewer can comment on the page and point at an element or a moment in its timeline. With "Send to agent" on, the comment is delivered as a message into the publishing session (`deliverCommentsToSession`). Who can steer:

- **The owner** (owner link or the owning account): their comments arrive as the user's own instructions.
- **A signed-in teammate who can see the page**: their comments arrive under their name, fenced as untrusted text, with a note telling the agent to weigh them against what its user asked for.
- **Anyone else**: their comments stay in the discussion and never reach the session.

The session answers by republishing, then resolves the comment (`cast publish comments --resolve`).

### 5. Sessions watch and write page state

This is the connection that turns a page into a place where a person hands work to an agent: a request desk, a review queue, an approval board.

```
viewer writes a row ──► pageState.write ──► page_state row
                                    │
                                    └─► trigger event page_state (5 s burst window)
                                              │
                                              ▼
                   watching session wakes with "who changed which row, value (200 chars)"
                                              │
                                              ▼
           cast publish state <page> <coll> --set key=<json>   (stamped with the session)
                                              │
                                              ▼
              every open copy updates over the Convex socket; row.agent = {session, title}
```

- `cast publish watch <page> [collection...]` arms an ordinary event trigger (`--on page_state --page <slug>`), so it appears in `cast trigger ls`. With `--spawn`, each burst starts a fresh session instead of waking this one.
- A burst of writes inside 5 seconds (`PAGE_COALESCE_MS`) becomes one run. The run receives one line per write, quoted as untrusted data, with the value cut to 200 characters so a small row needs no read.
- `cast publish state <page> <collection> --set | --insert | --patch | --delete | --clear` writes as the session's user, with the same rights that person has on the page. The write records `author_conversation_id`, so the page can show the row as the agent's. A session's own writes never wake it.
- `<cast-agent>` and `cast.agents(cb)` show viewers how many sessions are watching and how many are working on a change right now. Only counts are shown, not whose sessions they are.

So sessions already have write access to page state. Access is per collection (`read`: viewers, editors, owner; `write`: anyone, signed-in, editors, owner; `own` limits non-editors to their own rows). Caps are 4 KB a row, 2000 rows and 1 MB a collection, and 120 writes a minute per page from non-editors. Rows survive republish and rollback.

## Where the integration falls short

These are ordered by how much they limit real use. The first three are bugs or leaks in today's code; the rest are missing pieces.

### Bugs and leaks

**A person's edit keeps the agent's mark.** `writeRows` (`packages/convex/convex/pageState.ts`) adds `author_conversation_id` only when the writer is a session, and never clears it. If an agent writes a row and a person then edits it, the page still shows the row as the agent's answer. Fix: on every write that does not come from a session, clear `author_conversation_id`.

**Public pages show the session's title to anyone.** `viewRows` returns `agent: {session, title}` to every reader, and `title` is the conversation's title. On an open page that can show an anonymous visitor something like "Fix Cam's held confirmations". `agentsOn` deliberately hides whose sessions are watching, so this is inconsistent. Fix: return the title only to the owner and teammates, and a plain "agent" to everyone else.

**A `--spawn` watcher is told it has history it does not have.** `watchBrief` (`packages/cli/src/publishWatch.ts`) tells the woken session "your history here says why it exists". A spawned run starts fresh with only its prompt and the last run's summary, so it does not know what the page is for. Fix: when `--spawn` is set, require or capture the page's purpose at arm time and put it into the brief.

### Missing pieces

**1. Writes are one row per command.** An agent that answers ten requests runs `cast publish state` ten times, each one a separate action, a separate transaction and a separate event. There is no way to answer a request and mark it handled in one step. Add `cast publish state <page> --batch -` that reads newline-delimited ops and applies them in one mutation.

**2. Agent writes can overwrite a newer edit.** The session wakes, thinks, then writes. If the person changed the row in the meantime, `--set` overwrites their change without warning. `--patch` merges top-level fields, which helps only when the two writers touch different fields. Add an optional `--if-updated <ts>` (compare-and-set on `updated_at`) that refuses with the current row, so the agent can redo its work on the new value.

**3. "Working" is per page, not per row.** `cast.agents()` reports that some agent is working on some change. On a request desk, the person wants to see "the agent is on your request" next to their own row. The server already knows which rows woke each running trigger (its `pending_events`), so it can mark those rows `agent_working: true` in `list` and `get` without the agent doing anything. No new agent instruction is needed.

**4. Dashboards cannot show what a session computed.** `<cast-chart>` and `<cast-stat>` read only `queries`. A session that runs an eval or a benchmark has to republish the page to show new numbers. Let both elements take `state="<collection>"`, so a session writes result rows and the chart updates live, with the same "Updated" time and "Query" toggle showing which session wrote them.

**5. Two separate paths into a session.** Comments reach only the publishing session, as messages. State changes reach any watching session, as trigger runs. A page that wants both feedback and requests needs the owner to understand both. The publishing session could watch its own page's state by default when the page declares writable collections (shown in the publish output, turned off with `--no-watch`). That would make "people use my page, and I hear about it" the default for pages built as apps.

**6. Reads return the whole collection.** `accountRead` returns up to 2000 rows every time. A session on a busy desk reads everything to find the three rows that changed. Add `--keys a,b` and `--since <ts>` to `cast publish state`.

### Write access beyond page state

The idea of giving a session (or the page itself) write access to the database already holds for page state. The bigger question is whether a page should write to codecast's own records: file a task, post to a chat channel, send a message to a session, or call a connector action. Today only an agent can do that, after it wakes. A page can declare `queries` that read team data, but it cannot declare writes.

A path that fits the existing model:

- A page declares named `actions` in `cast-data.json`, beside `queries` and `state`. Each action names one existing verb (`task.create`, `chat.send`, `session.send`, `connector.<source>.<action>`) and a `write` level like a collection's (`editors` by default; never `anyone`).
- Publishing checks each action against the publisher's access, the same way it checks queries today, and refuses with the reason.
- An action runs as the publisher inside one workspace and is recorded with the page and the viewer who pressed it. Connector actions still need the grant a person makes on the web.
- The consequential-press rule applies: the page runtime shows a confirm step for actions that send, spend or publish.

This would let a team tracker file real tasks and an intake form post to a channel without waiting for an agent to wake. It is also the riskiest change on this list, because an open page could write team data on behalf of whoever opened it. That is why the default write level should be `editors` and actions should never be allowed on pages whose gates let anonymous viewers in. It needs a decision before anyone builds it; the bugs and items 1 to 4 above do not.
