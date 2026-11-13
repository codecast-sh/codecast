A huddle is a voice call with your team, started from a channel, a DM, the sidebar or a session. While it runs it is transcribed with the speaker's name on every line, and when it ends it gets a title, a summary and action items. Your agents can read all of it, so "as we discussed on the call" points at words an agent can open and quote.

You can also bring an agent into the huddle. A session hears the room as people talk, answers in the huddle's thread, and picks up the work when the call ends.

![A finished call's page with its summary, action items and the transcript under each speaker](/documentation/calls/call-page.webp "A finished huddle's page, with the summary above the full transcript.")

## Turn it on

Calls are a team feature. A new team starts with them on, and a team admin can switch them off or back on.

1. Open **Settings**, then **Team**, and find **Features**.
2. Check that **Calls** is on. While it is, everyone on the team sees the huddle buttons and **Calls** in the sidebar. Switched off, every huddle button disappears.
3. Your own preferences (camera, microphone, devices, walkie) live in **Settings** under **Calls**.

Turning calls on also teaches the agents on every member's computers to read the team's calls; it shows as the **Calls** card in **Agent Features**.

## Start a huddle

| Where | What happens |
|-------|--------------|
| **Huddle** in a channel's header | Starts the channel's huddle and buzzes its members |
| **Ring** in a DM, or on a teammate's face | Rings them. Their screen shows *Incoming huddle* with **Join** and **Decline** |
| **Start huddle** beside **Calls** in the sidebar (on hover) | Opens **New huddle**: pick one teammate or several, then **Start huddle** |
| **Huddle with this session** in a session's header menu | Talk to that session: what you say reaches its agent as you speak |

Before anyone is rung, **Start a huddle** shows your camera, a meter for your microphone and the device pickers, so you know you can be heard. Pick **Team** (teammates see it and can join) or **Private** (only people you ring in), then **Start**. Started from a channel, the dialog says how many members it will buzz, in orange when the channel is large. Answering a ring goes through the same check, and **Check camera and mic first** in your Calls settings turns it off.

![The Start a huddle dialog with a camera preview, the microphone meter, device pickers and the Team and Private toggle](/documentation/calls/start-huddle.webp "Checking camera and microphone before a huddle starts.")

Once someone is in a room, its button turns into a chip with their faces. **Happening now** on the Calls page lists every huddle running in your team.

## In the call

The bottom row has **Mute**, the camera, **Share your screen**, the button to ring a teammate or bring in a role or an agent, and **End call**. The top row shows whether the room is **open** (any teammate can walk in) or **locked** (teammates knock and someone inside lets them in), **invite** for guests, and the call's **thread**.

![A huddle with Alex Rivera, Maya Ortiz and Sarah Chen, the controls along the bottom and the thread open on the right](/documentation/calls/in-call.webp "A huddle in progress, with its thread open.")

## Transcripts and the digest

Every huddle is transcribed unless someone in it turns that off. The **transcribing · on** switch at the top of the thread belongs to the room, and anyone in it can flip it. The speaker on each line is never guessed: each person's microphone is transcribed on its own, so a line belongs to whoever spoke it.

When the huddle ends, a digest lands where it was held: a message in the channel or DM with the title, the length, who spoke, a summary and the action items, with the transcript a click away. A very short huddle keeps its words instead of a summary.

![The digest of a finished huddle in the #eng channel, with its title, length, speakers, summary and action items](/documentation/calls/digest.webp "The digest a huddle leaves in its channel.")

The **Calls** page lists every huddle and voice note you can open, live ones first, with a filter for calls with video. Click one to open its page: the summary, the action items and the whole transcript, plus the video if it was recorded. **Record a voice note** at the top records just your microphone; a voice note starts private to you, and you can share it into a team from its page.

## Agents and calls

Agents read calls the way you would read a page. Ask in plain words:

- "What did we agree on yesterday's call about the webhook retries?"
- "Turn the action items from this morning's huddle into tasks, each quoting who took it on."
- "What was on screen when Maya talked about the retry delay?" (for a recorded call)
- "Summarize every call this week where billing came up."

When an agent quotes a call, the quote shows the speaker and links to those lines on the call's page.

![An agent's reply quoting two transcript lines from a huddle, each under its speaker, with a pill linking to the call](/documentation/calls/agent-quote.webp "An agent quoting the exact lines from a call.")

**Bring a session into the huddle.** Start a huddle from a session's header menu, or click **Add an agent** in the call's thread and pick **A new agent session** (*Hears the room and answers here*). The session hears what is said each time the room goes quiet, waits for a complete thought, and answers in the thread. A line you type in the thread goes straight to it. When the call ends it already knows what happened.

![A huddle's thread where a typed question goes to the agent and its answer appears marked as an agent](/documentation/calls/huddle-agent.webp "A session answering in a huddle's thread.")

After a call, **Send to agent** on its page hands the whole call, or the lines you selected, to a session with an optional note. Click a line, and `Shift`-click another to extend the selection.

## Record the video

Press **Record this huddle** on the call, or on its card at the top of the window beside **Mute**. Everyone in the call is told, guests included, and a red **REC** mark shows wherever the call does. Stopping asks once more, because it stops for everyone, and recording stops by itself when the huddle ends.

On the call's page the video plays beside the transcript and stays in step with it. Click a line to jump to that moment; the line being said lights up as it plays, and **Back to the moment** returns to it after you scroll away. You can copy a link to the exact second. A screen share is kept at full resolution, so code on a shared screen stays legible, and you can switch the view to it.

![A recorded call's page with the video on the left and the transcript on the right, the current line highlighted](/documentation/calls/call-video.webp "A recorded huddle, with the video in step with the transcript.")

Whoever can open the call's room can watch its video. Whoever pressed record, or a team admin, can delete the recording. A call can also get a public link; the video joins it only if someone turns on **Include the video recording**.

## Guests

Click **invite** in the call (or **Invite guest** on a live call's page) and send the link. A guest opens it in any browser with no account, sees who invited them and whether the call is transcribed or recorded, and waits at the door. Anyone inside clicks **Admit** or turns them away. If nobody is in the room yet, whoever made the link is told.

A link lasts 1 hour, 1 day, 7 days (the default) or 30 days, and can be turned off. Inside, a guest is marked as a guest on every face and line. They see and hear the call and nothing else: not the team, its sessions, the transcript or the call's thread. When the last teammate leaves, the guests are let go too.

## Walkie

Walkie is push to talk into a DM, for a quick word without a call. Click **Talk** on someone's face or in the DM, or press `Ctrl` `Shift` `Space` in the DM, say it, and click again to stop. A teammate at their desk hears you live, the words appear in the DM while you talk, and the message lands with the recording for anyone who wasn't there. Nobody hears you back unless they click **Join live**, which turns it into a call.

```figure
WalkieFigure
The people wall, sized by who is around, and a walkie message landing in a DM while it is spoken.
```

The people wall (`Cmd` `Shift` `P`) shows your team's faces, larger for whoever is at their desk. Click a face to talk, ring or message them. Set yourself **busy** or **away** from your own face: when you are busy, rings arrive without sound and walkie messages wait in the DM. Switch off **Let teammates talk to me** in your Calls settings and their voice no longer plays out loud; it still arrives in the DM with its words.

## On your phone

On the iPhone a ring shows on the lock screen like a phone call, even when the app is closed. The call screen has mute, camera, speaker, record, and **Invite a guest**, which makes a link and opens the share sheet. Guests knocking show at the door with **Admit**.

![The iPhone call screen with three faces, the mute, camera, speaker and record controls, and Invite a guest](/documentation/calls/phone-call.webp "A huddle on the iPhone.")

## When something is off

| What you notice | What to do |
|-----------------|------------|
| No huddle buttons anywhere | Calls are switched off for this team. Ask a team admin to switch on **Calls** under Settings, Team |
| The call has no summary | It was too short to summarize, or the summary failed. The transcript is still on its page |
| Nothing was transcribed | Someone turned **transcribing** off. Turn it back on for the rest of the call |
| The record button is dimmed | Recording isn't available right now; hover it to see why |
| A guest's link doesn't open the call | It expired or was turned off. Make a new one from **invite** |
| Walkie messages don't play out loud | You are set to busy, or **Let teammates talk to me** is off. They are waiting in the DM |
