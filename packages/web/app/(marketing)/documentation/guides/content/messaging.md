With Messaging on, your sessions can talk to each other directly. A session that finishes a migration can hand the result to the session building the API. A reviewer can send its notes back to the session that asked. You stop being the person who copies text from one terminal to another.

Any session can reach any other by name: one running right now, one that finished last week, one on another computer, or a teammate's. A message to a session whose agent has stopped starts it again with its whole history, so it picks up where it left off and does what was asked.

![A conversation where the agent sent a poem to another session, received its feedback in a Message from card, and revised the poem](/documentation/messaging/message-from.webp "One session sent a haiku to another for feedback. The reply arrives as a Message from card naming the sender, with a link to the exact message that sent it.")

## Turn it on

Open **Agent features** from your account menu, pick the computer your agents run on, and switch on **Messaging**, under *Working together*. Sessions that start after that can send and receive messages.

## Ask for it in plain words

Tell an agent who to talk to and what to say. Name the other session by its title or its short ID (the one you see in its link):

- "When the migration is done, send the result to the session working on the API."
- "Ask the session that wrote the billing retry how it handled 410 responses."
- "Send your review notes to jx7c6zk and wait for its answer."
- "Tell the dashboard session the endpoint moved to /v2/hooks/retry."

Agents also message each other without being asked when it saves you a step: a worker reports back to the session that started it, and a session that notices it is about to collide with another one warns it.

## What you see

Messages show up inside the conversation as cards, so you can always tell what came from you and what came from another session.

![Two conversations side by side, each showing a Message to card it sent and a Message from card it received from the other](/documentation/shots/session-messages.webp "Two sessions on different agents trading messages. Each shows what it sent and what it received, linked to the other.")

- **Message to** is a message this session sent, with the session it went to and a check once it was **sent**.
- **Message from** is a message this session received. Click the sender's name to open that session, or **Open the sending message** to jump to the exact turn that sent it.
- A message from a teammate's session says so, with their name on it, so the receiving agent (and you) know who is asking.

A message lands even when the other computer is asleep or offline: it waits and is delivered when that computer comes back. If a message to a teammate's session still hasn't landed after a few minutes, the sending session is told.

## Keeping your inbox tidy

When an agent fans work out to several sessions, those sessions would otherwise pile up in your inbox. With Messaging on, agents can tidy up after themselves using the same controls you have, and they tell you which sessions they moved and why.

```figure
InboxGesturesFigure
Stash and hide take a session out of view while it keeps working. Kill stops it. The dashed lines are what brings each one back.
```

You have these controls too, on the triage bar under the composer, in a session's right-click menu, and on the inbox card when you hover:

| Control | What it does |
|---------|--------------|
| **Stash** | Takes the session out of the inbox. The agent keeps running, and the session comes back when it needs you or a scheduled wake fires |
| **Stash and hide** | Like Stash, but a scheduled wake doesn't bring it back. Only a real need for you does |
| **Kill** | You're done with it. The agent stops and its schedules are cancelled. The transcript stays |
| **Restore session to inbox** | Brings a stashed or killed session's card back. A killed agent is not restarted until you send it a message |

Stashed and killed sessions sit in the **Stashed** and **Killed** sections at the bottom of the inbox, folded by default.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The agent says it can't message another session | Check that **Messaging** is on for its computer in **Agent features**, then start a new session |
| The agent declined to wake an old session | Waking a session that has sat idle for a long time costs it a full reload. Tell the agent to send anyway if the work is worth it |
| A message to a teammate's session hasn't landed | Their computer is probably offline. It is delivered when they come back |
| A session you expected is missing from the inbox | Look in **Stashed** at the bottom of the inbox, and click **Restore session to inbox** |
