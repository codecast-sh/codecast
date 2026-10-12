A session runs on one computer. That is a limit when your laptop has to close, when thirty sessions compete for its memory, or when the work needs a Linux box or a Mac with Xcode. Codecast lets a session run on any machine you've connected, including a cloud machine in your own AWS account, and you watch and steer it from the same inbox, on the web, the Mac app or your phone. Moving a session between machines keeps it one conversation: the agent picks up where it was, on the new machine.

![A Codex session running in a cloud worktree, its header naming the worktree](/documentation/remote-and-cloud-sessions/cloud-worker.webp "A session running on a cloud machine. Its header and inbox row name the worktree it runs in there; otherwise it is the same thread as any session on your laptop.")

A task that runs on a vendor's machines rather than yours, such as a Codex Cloud task, works differently: see [Codex Cloud tasks in codecast](/documentation/codex-cloud).

## Your machines

**Settings → Devices** lists every machine connected to codecast, whether it's online, and the repositories on it. To connect another computer of yours, install codecast on it ([Getting started](/documentation#getting-started)); it appears here once it signs in.

### Add a cloud machine

**Add a cloud machine** on the same page sets up a Linux or Mac machine in your own AWS account. Pick Linux (general development, sleeps when idle) or Mac (Xcode, iOS and macOS work), then either connect an instance you already have or create a new one, and fill in the AWS details. The dialog builds a setup command; copy it and run it once in a terminal on your laptop, from your project. It needs the AWS command line tool signed in and SSH access to the machine. Setup installs the tools, copies your agent configuration over, and waits for the machine to come online.

![The Add a cloud machine dialog](/documentation/remote-and-cloud-sessions/add-cloud-machine.webp "Add a cloud machine builds the one command that sets the machine up. Setup can be rerun after a failure; work already on the machine is kept.")

Once it's set up, the machine's row shows whether it's awake or asleep, its size and region, what it costs per hour awake and per month for its disk, and when it goes to sleep. Its buttons wake it or put it to sleep, apply the repository's setup again, and **Save image**, which snapshots the machine so the next one you create starts ready.

**What it costs.** AWS bills you directly. A Linux machine bills for compute only while it's awake and goes to sleep on its own after a stretch with no work; its disk bills all the time. An AWS Mac needs a dedicated host with a 24 hour minimum, and the host bills while it's allocated, awake or asleep, so a Mac doesn't sleep on its own.

## Start a session on another machine

When you have more than one machine, the composer shows which one the new session will run on. Click it to pick another.

With a cloud machine, a **run in the cloud** switch appears under the composer. The session then runs in its own worktree on the cloud machine, starting from your checkout as it stands, uncommitted changes included. Two related switches:

- **isolated worktree**: on (the default) gives the session its own worktree on the cloud machine. Off runs it in the machine's main checkout, which is refused if that checkout has changes or another session is using it.
- **start from**: **my checkout** carries your current work over; **origin/main** starts clean.

An asleep cloud machine wakes when a session starts on it. The header reads *preparing cloud host* while its checkout is being made.

## Move a session

Click the machine name in a conversation's header for **Run on device · which machine**. Pick another machine to move the session there: its worktree, its uncommitted changes and its conversation travel with it, and the agent resumes on the new machine. An asleep cloud machine is marked *asleep, wakes on move*.

![The machine menu in a conversation's header](/documentation/remote-and-cloud-sessions/machine-menu.webp "The session runs here on the laptop; it can move to either of two cloud machines.")

The transcript marks the move with a rule reading *now running on …*, and the agent is told which machine it's on now. Messages you send during the move wait and are delivered once it lands.

To move many sessions at once, select them in the inbox (⌘-click, shift-click for a run) and choose **Move to…**, or open **Settings → Migration**. Migration lists your sessions with filters, lets you pick a destination, and asks how to treat sessions that are mid-turn: interrupt them, or wait for them to finish up to a time you choose. A session waiting on a permission prompt moves at once, and the prompt asks again on the new machine.

## Work on a cloud session's files from your laptop

For a session on a cloud machine, the machine menu offers **Sync with** your laptop. The session's folder is then kept in step with a copy on your laptop, both ways: the agent's edits appear there within seconds, so you can open, run and test them locally, and your edits there reach the agent.

- A chip in the header shows the sync's state: *in step*, *syncing*, or *paused* while the session is idle (so the cloud machine can sleep).
- Dependency and build folders, very large files and media stay on their own machine; each side builds its own. The chip lists what stayed behind and why.
- When both sides change the same file, only that file holds. The chip offers **Keep the laptop's** or **Keep the cloud's** for each, and everything else keeps flowing.
- **Cloud to laptop only** makes the laptop copy a mirror you read rather than edit.

## Watch and type into a session on another machine

- **The terminal.** The **tmux** pill in the header opens the agent's terminal above the conversation. For a session on another machine it's relayed, so typing works but each keystroke takes a moment: fine for answering an agent, slow for a full screen editor.
- **The agent's browser.** On a cloud machine, agents use a browser of their own there. **watch live** on a browser step shows its tab beside the conversation, and **Take the wheel** gives you the mouse and keyboard, for example to sign in where the agent can't. **Hand back** returns it.
- **The whole screen.** From the browser watch, the screen button opens the cloud machine's whole display in a **Host screen** pane, for a popup, a file picker or a dialog outside the tab. It opens from codecast on the laptop that manages the machine.

```figure
BrowserWatchFigure
The browser watch beside a cloud session: the agent's tab, live. Take the wheel when it needs you to sign in.
```

## What a cloud machine gets from your laptop

You don't set a cloud machine up by hand. Your laptop keeps it in step with how you work:

- **Your agent setup**: instruction files, agent settings, skills, hooks and your codecast feature switches, plus your shell setup.
- **Your sign-ins**: Claude, Codex and the other agents, and tools such as GitHub, AWS, Cloudflare and Vercel. They travel from your laptop over SSH, never through codecast's servers, and only while they're valid.
- **Your tools**: the agents and command line tools your laptop uses, at the same versions.
- **Agent memory**, both ways: what an agent learns on the cloud machine comes back to your laptop.

If a repository needs more on the machine, such as a database or a system package, ask an agent to add it to the repository's codecast setup; the machine applies it on its next wake.

## Pushing code from a machine

A cloud machine can push to GitHub without anyone handing it a key, through the codecast GitHub app when it's installed for the repository. Otherwise, or on any other machine that can't reach a repository, **Settings → Devices** shows the repository as **needs access** with a public key and a **Copy** button. Add it to the repository on GitHub as a deploy key with write access. It starts working within minutes; there's nothing else to run.

## Keeping a busy machine responsive

A session you aren't using can be **hibernated**: its agent stops and frees the machine's memory, and the conversation stays exactly where it was. Above the message box it reads *hibernated, resumes on send*; sending a message brings it back. The **Sessions** page has a **Hibernated** filter and **Hibernate idle**, and the **Resources** page shows each session's CPU and memory with **Park** and **Resume**. A session that's mid-turn, waiting on a permission prompt or running background work is never parked.

## On your phone

The iPhone app shows which machine a session runs on in its header; tap it to move the session to another machine. A new session can pick its **Machine**. The app only offers machines that are online, so wake an asleep cloud machine from the web or the Mac app first.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The cloud machine shows **Asleep** and nothing starts | Start or move a session there, or click **Wake** in Settings → Devices. Your laptop has to be online to wake it |
| Wake and sleep buttons say the laptop is offline | Actions on a cloud machine run through the laptop that manages it. Open that laptop |
| A repository shows **needs access** | Add the shown key on GitHub as a deploy key with write access |
| The sync chip says files changed on both sides | Pick **Keep the laptop's** or **Keep the cloud's** for each file |
| The terminal says *paused* | The machine is asleep or offline. Wake it, then **Reconnect** |
