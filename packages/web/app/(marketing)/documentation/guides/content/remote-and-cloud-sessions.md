A session runs on one computer. That is a limit when your laptop has to close, when thirty sessions compete for its memory, or when the work needs a Linux box or a Mac with Xcode. Codecast lets a session run on any machine you've connected, including a cloud machine in your own AWS account, and you watch and steer it from the same inbox, on the web, the Mac app or your phone. Moving a session between machines keeps it one conversation: the agent picks up where it was, on the new machine.

![A Codex session running in a cloud worktree, its header naming the worktree](/documentation/remote-and-cloud-sessions/cloud-worker.webp "A session on a cloud machine is the same thread as one on your laptop.")

A task that runs on a vendor's machines rather than yours, such as a Codex Cloud task, works differently: see [Codex Cloud tasks in codecast](/documentation/codex-cloud).

## Your machines

**Settings → Devices** lists every machine connected to codecast, whether it's online, and the repositories on it. To connect another computer of yours, install codecast on it ([Getting started](/documentation#getting-started)); it appears here once it signs in.

![Settings, Devices: a laptop and a Linux cloud machine with its state, size, cost and Wake button](/documentation/remote-and-cloud-sessions/devices.webp "Every machine, with each cloud machine's state and cost.")

### Add a cloud machine

**Add a cloud machine** on the same page sets up a Linux or Mac machine in your own AWS account. Pick Linux (general development, sleeps when idle) or Mac (Xcode, iOS and macOS work), then **Connect existing** or **Create new**, and fill in the AWS details.

![The Add a cloud machine dialog](/documentation/remote-and-cloud-sessions/add-cloud-machine.webp "The dialog builds the one command that sets the machine up.")

This step still ends in a terminal: **Copy setup command** gives you one command to run on your laptop, from your project. It needs the AWS command line tool signed in and SSH access to the machine. Setup installs the tools, copies your agent configuration over, and waits for the machine to come online. It can be rerun after a failure; work already on the machine is kept.

Once it's set up, the machine's row shows whether it's **Awake** or **Asleep**, its size and region, what it costs per hour awake and per month for its disk, and when it goes to sleep. Its buttons are **Wake** or **Sleep**, **Apply setup now** (installs what the repository's setup asks for), and **Save image**, which snapshots the machine so the next one you create starts ready.

**What it costs.** AWS bills you directly. A Linux machine bills for compute only while it's awake and goes to sleep on its own after a stretch with no work; its disk bills all the time. An AWS Mac needs a dedicated host with a 24 hour minimum, and the host bills while it's allocated, awake or asleep, so a Mac doesn't sleep on its own.

## Start a session on another machine

When you have more than one machine, the new-session composer shows which one the session will run on. Click it to pick another.

With a cloud machine connected, the menu that says where the session runs offers **This checkout**, **Isolated worktree** and the cloud machine by name. Pick the cloud machine and the session runs in its own worktree there, starting from your checkout as it stands, uncommitted changes included. Two more choices sit in the same menu:

- **On the host**: **own worktree** (the default) or **main checkout**. The main checkout is refused if it has changes or another session is using it.
- **Start from**: **my checkout** carries your current work over; **origin/main** starts clean.

![The new-session composer's placement menu with This checkout, Isolated worktree and a cloud machine](/documentation/remote-and-cloud-sessions/placement-menu.webp "Pick where the session runs before you send.")

An asleep cloud machine wakes when a session starts on it. The header reads *preparing cloud host* while its checkout is being made.

## Move a session

Click the machine name in a conversation's header for **Run on device · which machine**. Pick another machine to move the session there: its worktree, its uncommitted changes and its conversation travel with it, and the agent resumes on the new machine. An asleep cloud machine is marked *asleep, wakes on move*.

![The machine menu in a conversation's header](/documentation/remote-and-cloud-sessions/machine-menu.webp "The session runs on the laptop and can move to either cloud machine.")

The transcript marks the move with a rule reading *now running on …*, and the agent is told which machine it's on now. Messages you send during the move wait and are delivered once it lands.

To move many sessions at once, select them in the inbox (⌘-click, shift-click for a run) and choose **Move to…**, or open **Settings → Migration**. Migration lists your sessions with filters, lets you pick a destination, and asks how to treat sessions that are mid-turn: interrupt them, or wait for them to finish up to a time you choose. A session waiting on a permission prompt moves at once, and the prompt asks again on the new machine.

## Work on a cloud session's files from your laptop

For a session on a cloud machine, the machine menu offers **Sync with** your laptop. The session's folder is then kept in step with a copy on your laptop, both ways: the agent's edits appear there within seconds, so you can open, run and test them locally, and your edits there reach the agent.

![The sync chip in a cloud session's header, reading in step, with its menu open](/documentation/remote-and-cloud-sessions/sync-chip.webp "The sync chip says whether the laptop copy is in step.")

- A chip in the header shows the sync's state: *in step*, *syncing…*, or *sync paused* while the session is idle (so the cloud machine can sleep). Its menu opens the copy in VS Code or Cursor, switches between **Both ways** and **Cloud to laptop only**, and has **Stop syncing**.
- Dependency and build folders, very large files and media stay on their own machine; each side builds its own. The chip lists what stayed behind under **Stayed on its own machine**.
- When both sides change the same file, only that file holds. The chip offers **Keep the laptop's** or **Keep the cloud's** for each, and everything else keeps flowing.
- **Cloud to laptop only** makes the laptop copy a mirror you read and don't edit.

## Watch and type into a session on another machine

- **The terminal.** The terminal pill in the header, which names the machine for a session that runs elsewhere, opens the agent's terminal above the conversation. For a session on another machine it's relayed, so typing works but each keystroke takes a moment: fine for answering an agent, slow for a full screen editor.
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

If a repository needs more on the machine, such as a database or a system package, ask an agent to add it to the repository's codecast setup; the machine applies it on its next wake, or right away with **Apply setup now**.

## Pushing code from a machine

A cloud machine can push to GitHub without anyone handing it a key, through the codecast GitHub app when it's installed for the repository. Otherwise, or on any other machine that can't reach a repository, **Settings → Devices** shows the repository as **needs access** with a public key and a **Copy** button. Add it to the repository on GitHub as a deploy key with write access. It starts working within minutes; there's nothing else to run.

## Keeping a busy machine responsive

A session you aren't using can be **hibernated**: its agent stops and frees the machine's memory, and the conversation stays exactly where it was. Above the message box it reads *hibernated, resumes on send*; sending a message brings it back. The **Sessions** page has a **Hibernated** filter and **Hibernate idle**, and the **Resources** page shows each session's CPU and memory with **Park** and **Resume**. A session that's mid-turn, waiting on a permission prompt or running background work is never parked.

## On your phone

The iPhone app shows which machine a session runs on in its header; tap it to move the session to another machine. A new session can pick its **Machine**. The app only offers machines that are online, so wake an asleep cloud machine from the web or the Mac app first.

![The phone's new session sheet with the Machine picker open](/documentation/remote-and-cloud-sessions/phone-machine.webp "On the phone, a new session picks its machine.")

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The cloud machine shows **Asleep** and nothing starts | Start or move a session there, or click **Wake** in Settings → Devices. Your laptop has to be online to wake it |
| Wake and sleep buttons say the laptop is offline | Actions on a cloud machine run through the laptop that manages it. Open that laptop |
| A repository shows **needs access** | Add the shown key on GitHub as a deploy key with write access |
| The sync chip says files changed on both sides | Pick **Keep the laptop's** or **Keep the cloud's** for each file |
| The terminal says *paused* | The machine is asleep or offline. Wake it, then **Reconnect** |

## For agents and scripts

Agents start work on a cloud machine with `cast spawn --cloud`, move sessions in bulk with `cast migrate`, and keep a laptop copy with `cast remote sync`. `cast hosts` manages the machines themselves.
