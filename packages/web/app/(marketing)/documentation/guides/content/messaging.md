With Messaging on, your sessions talk to each other directly. A session that finishes a migration hands the result to the session building the API. A reviewer sends its notes back to the session that asked. You stop copying text from one terminal to another.

Any session can reach any other by name: one running now, one that finished last week, one on another computer, or a teammate's. A message to a session whose agent has stopped starts it again with its whole history, so it picks up where it left off and does what was asked.

![A conversation where the agent received feedback from another session in a Message from card and revised its work](/documentation/messaging/message-from.webp "A reply from another session, with a link back to the message that sent it.")

## Turn it on

Open **Settings**, pick **Agent Features** under *Machines*, choose the computer your agents run on, and switch on **Messaging** under *Working together*. Sessions that start after that can send and receive messages.

## Ask for it

Tell an agent who to talk to and what to say. Name the other session by its title or by the short ID in its link:

- "When the migration is done, send the result to the session working on the API."
- "Ask the session that wrote the webhook retry how it handled 410 responses."
- "Send your review notes to the retry-queue session and wait for its answer."
- "Tell the dashboard session the endpoint moved to /v2/hooks/retry."

Agents also message each other without being asked when it saves you a step: a worker reports back to the session that started it, and a session about to collide with another one warns it.

## Messages in the conversation

Messages show inside the conversation as cards, so you can tell what came from you and what came from another session.

![Two conversations side by side, each showing a Message to card it sent and a Message from card it received from the other](/documentation/shots/session-messages.webp "Two sessions on different agents trading messages.")

- **Message to** is a message this session sent, with the session it went to.
- **Message from** is a message this session received. Click the sender to open that session, or the arrow beside it (*Open the sending message*) to jump to the exact turn that sent it.
- A message from a teammate's session carries their name, so the receiving agent and you know who is asking.

A message lands even when the other computer is asleep or offline: it waits and is delivered when that computer comes back. If a message to a teammate's session still hasn't landed after a few minutes, the sending session is told.

The iPhone app shows the same **Message to** and **Message from** cards in a session.

## Keeping your inbox tidy

When an agent fans work out to several sessions, those sessions would pile up in your inbox. With Messaging on, agents tidy up after themselves using the same controls you have, and tell you which sessions they moved and why.

![A session's right-click menu in the inbox with Stash, Stash and hide and Kill session](/documentation/messaging/triage-menu.webp "The controls for moving a session out of the inbox.")

You find these controls in a session's right-click menu, and on the inbox card when you hover. On the iPhone, press and hold a session for **Stash** and **Kill session**.

| Control | Keys | What it does |
|---------|------|--------------|
| **Stash** | `Ctrl` `Backspace` | Takes the session out of the inbox. The agent keeps running, and the session comes back when it needs you or a scheduled wake fires |
| **Stash and hide** | `Ctrl` `Alt` `Backspace` | Like Stash, but a scheduled wake doesn't bring it back. Only a real need for you does |
| **Kill session** | `Ctrl` `Shift` `Backspace` | You're done with it. The agent stops and its schedules are cancelled. The transcript stays |
| **Restore session to inbox** | | Takes the place of Stash on a session that is already out of the inbox, and brings it back. A killed agent restarts only when you send it a message |

```figure
InboxGesturesFigure
Stash and hide take a session out of view while it keeps working. Kill stops it. The dashed lines are what brings each one back.
```

Stashed and killed sessions sit in the **Stashed** and **Killed** sections at the bottom of the inbox, folded by default.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The agent says it can't message another session | Check that **Messaging** is on for its computer in **Agent Features**, then start a new session |
| The agent declined to wake an old session | Waking a session that has sat idle for a long time costs it a full reload. Tell the agent to send anyway if the work is worth it |
| A message to a teammate's session hasn't landed | Their computer is probably offline. It is delivered when they come back |
| A session you expected is missing from the inbox | Look in **Stashed** at the bottom of the inbox, and pick **Restore session to inbox** |
