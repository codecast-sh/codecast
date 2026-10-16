A long session is hard to walk back into. The transcript holds everything the agent did, in order, which is the wrong shape for the question you have when you open it: where does this stand right now?

With Thread State on, the agent keeps one short note pinned to the session that answers that question: what it is working on, where things stand, what comes next, and whether anything is yours to decide. It rewrites the note as the work moves and clears it when it stops being true. You see it above the composer the moment you open the session, and on the session's inbox card before you open anything.

![The pinned state above the composer: a Needs input chip and the headline on one line, then a You line on amber, a Done checklist and a Next line](/documentation/thread-state/pinned-panel.webp "A pinned state in a conversation. The chip says who acts next, the headline says where the work stands, and the You line is what the agent needs from you.")

## Turn it on

Open **Agent features** from your account menu, pick the computer your agents run on, and switch on **Thread State**. Sessions that start after that keep a pinned state. Click **How it works** on the card for what you'll see and a request to try.

You don't need to ask for it once it is on, but you can steer it:

- "Keep your thread state current while you work through this refactor."
- "Put the open question about the API key in your pinned state."
- "Clear your pinned state, the work is done."

## What you see

**In the conversation**, the note sits in a panel just above the composer:

- The header is the answer: a status chip (**In progress**, **Needs input**, **Complete** or **Dormant**) and the headline, one line on where the work stands. A note without a status shows **Pinned**.
- On the right, how old it is, such as *4m*. Once the thread has run well past the note, it turns yellow, and when messages are why, it counts them: *4h · 64 new messages*.
- Under the header, each detail line sits beside its label. **You** is what the agent needs from you, on amber, with a **Copy** button when it is a command. **Done** is a checklist of what is finished, and **Next** says what happens next and when. A long note folds to **Show all**.
- Click the header to collapse the panel to the headline. The **×** that appears on hover clears the note; a toast reads *Pinned state cleared* with **Undo**.

**On the inbox card**, the note replaces the generated summary with one line: what the agent needs from you when there is something, otherwise the headline. A small pin marks it, colored by status, and a chip names a blocked, done or dormant session so you can scan the inbox without opening anything.

## Who acts next

The status on the note decides where the session files in your inbox when the agent's turn ends.

```figure
WhoActsNextFigure
The status the agent pins decides the inbox section. A turn that says nothing files under Needs Input, so you open it and find out.
```

- **Needs input** is the one status that asks for you. It brings a stashed session back to the inbox, so agents use it only when they truly can't continue without you. A question that can wait goes to your [decision queue](/documentation/decisions) instead.
- **Complete** and **Dormant** cover only the turn that set them. A dormant note says what will wake the session: a schedule, a background job, a reply from another session.
- When you send the session a message, the note comes down, because you have answered it. The agent pins a fresh one when its turn ends. A message from another session or a scheduled wake leaves the note standing.

## A note that has gone stale says so

Nothing forces an agent to keep the note current, so codecast never pretends it is. Every note shows how far the thread has moved since it was written, and the panel changes as that gap grows.

```figure
FreshnessFigure
Fresh, aging, then hidden, by messages or by hours, whichever comes first.
```

For its first 60 messages the note is fresh. After that its age turns yellow and the header counts the messages since. At 200 messages it is hidden everywhere, because a line the thread has run far past is worse than no line. Time counts too, more gently: a session parked overnight on a long test run hasn't changed, so the clock only ages a note after 12 hours and hides it after 48. Each rewrite starts both counts again.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| No pinned state on new sessions | Check that **Thread State** is on for the computer the session runs on, in **Agent features** |
| The note says the agent is waiting on something that already happened | Tell the agent. It rewrites the note when it ends that turn |
| A session sits in Needs Input but needed nothing | The agent ended its turn without saying who acts next. Ask it to keep its pinned state current |
| You cleared a note by mistake | Click **Undo** on the toast, or ask the agent to pin it again |
