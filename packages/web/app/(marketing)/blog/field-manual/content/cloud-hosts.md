Cloud agent products usually start from a clean clone of `main` in someone else's sandbox: your uncommitted change, your `.env.local`, your agent config and your logins are not there. Codecast's cloud hosts are machines in your own AWS account (Linux, or a Mac), and a session sent there starts *from the checkout you are standing in*, uncommitted and gitignored files included. Its edits mirror back to your laptop as they happen, it reports into the same inbox as everything else, and whole batches of sessions move between laptop and host without losing a message.

![Left, on a cream laptop background: git status shows a modified src/routes/v1.ts and an ignored .env.local, then a cloud spawn snapshots a41c9e2 plus one change and reports jx7k2pd running on ip-172-31-40-243; below, the synced worktree tree with the agent's edits. Right, on a dark host background: a checklist (woke the host, fetched, copied .env.local, agent logins pushed, worktree acquired, branch reset with v1.ts uncommitted again) and the claude session's tool calls.](/blog/field-manual/cloud-hero.webp "One cloud session, condensed: the laptop on the left, the host on the right, one conversation throughout.")

## Choosing where a session runs

Adding a host is a dialog in Settings, under Devices: pick Linux or Mac, connect an instance you already have or create a new one, and run the setup command it gives you. From then on the host shows up next to your laptops. Its panel says whether it is awake, waking, going to sleep or asleep, what it costs, and when it will sleep, with buttons to wake it, put it to sleep, or re-apply your setup.

To start a session there, flip **run in the cloud** in the composer. A **start from** choice appears: **my checkout** (the default, your exact working state) or **origin/main** for a clean start. Each session gets its own worktree on the host unless you turn off **isolated worktree** to use the host's main checkout. A sleeping host wakes itself when the session starts.

Once it runs, the session header carries a chip with the machine's name and an online dot ("preparing cloud host" while it sets up). The chip's menu, **Run on device**, lists every machine you can use: the current one marked **running here**, a cloud host as **Move to ip-172…** (with "asleep, wakes on move" when it is), a laptop as **run here**. The same menu exists on the phone, so you can push a session to the host from the couch.

## What arrives on the host

Your branch, unpushed commits, and uncommitted, untracked and gitignored files are captured without anything in your checkout moving, and the host restores them as uncommitted work, so the agent sees what you saw. All of this goes from your laptop to the host over SSH, never through codecast's servers. If any step fails, the session fails with git's error; it never quietly falls back to `main`.

![Two commit graphs. Laptop: commit a41c9e2 not pushed, modified v1.ts and .env.local captured by a temporary index into a snapshot commit. Host: the same a41c9e2 on feature/checkout, with v1.ts and .env.local uncommitted again.](/blog/field-manual/cloud-spawn.webp "The snapshot carries your exact working state across, and the host restores it as uncommitted work.")

The host is also set up like your laptop: your agent config and instruction files, your shell setup, logins for Claude, Codex, GitHub, Cloudflare, AWS and the rest (each only while its token is live), and the same CLI versions you use. Some things deliberately stay home: your Anthropic API key and Google browser logins never travel. What the repo itself needs (Postgres, Redis, a seed script) is declared once for the project and converges every time the host wakes.

## A live mirror back to your laptop

From the machine chip on a cloud session, **Sync with MacBook-Pro** keeps a copy of the session's folder on your laptop, both ways, a few seconds behind. Open it in Cursor or VS Code straight from the menu, run the tests locally, or fix a line yourself and the agent sees it. The chip reads "in step" with the time of the last sync, or "laptop copy edited" when you have changed something. If you only want to watch, switch the direction to **Cloud to laptop only**.

Gitignored files travel too. Dependency and build folders, media, compiled programs, very large files and nested repos stay on their own side, and the menu lists exactly what under **Stayed on its own machine**. When both sides change the same file, only that file pauses under **Changed on both sides**, with **Keep the laptop's** and **Keep the cloud's**; everything else keeps flowing. A change applies only if its folder has not changed since it was read, so nothing lands mid-edit. While the session is idle the sync pauses, so the host can still sleep.

![The machine menu for session jx7k2pd: Synced with MacBook-Pro, both ways; one file held because it changed on both sides with Keep the laptop's and Keep the cloud's buttons; a list of what stayed on the host (node_modules, a video, a large dump); next to it four cards: Everything travels, Only the conflicting files hold, Nothing lands mid-edit, The host still sleeps.](/blog/field-manual/cloud-mirror.webp "A conflict holds one file, not the sync. Heavy and machine-specific files stay on their side.")
![The codecast app from the product film: a Codex session titled Webhook API half running on cloud-4f2a91, which opened a cast browser tab in Chrome on linux-host-1; the inbox on the right lists sessions on the laptop and the cloud host together.](/blog/field-manual/film-remote.webp "From the homepage film's Anywhere chapter: a Codex session on a cloud host sits in the same inbox as the laptop's sessions, browser tab and all.")

## Moving twenty sessions before you close the lid

Select sessions in the inbox, right-click, and choose **Move 20 sessions to** a machine (the command palette has **Move to machine…** too). A toast confirms the batch and its **Progress** button opens the migration page in Settings, where you can also build a batch from scratch: destination, sessions, how many transfer at once, and what to do about running turns.

That last setting is the careful part. A session in the middle of a turn finishes it first, waiting up to a limit you choose (two minutes to an hour, or interrupt right away). Messages you send to a session while it is moving are held, marked "message waiting" on its row, and delivered on the destination, so nothing is lost either way. A session sitting at a permission prompt moves at once and asks again on the other side.

Each row walks through **waiting for turn**, **stopping**, **transferring**, **handing off** and **resuming**; the batch reads "all moved" or "partly moved", with **Retry failed** for any that did not. In the thread, a divider marks the move ("now running on ip-172-31-40-243, was MacBook-Pro"), and the agent is told which machine it is on now.

![Batch mg-4k7q2z9a with five columns Fence, Wait, Quiesce, Transfer, Flip, and five sessions at different stages: one resumed on the host, one sharing a worktree pushed once, one at a prompt moving now, one mid turn finishing first with 2 messages waiting, one queued.](/blog/field-manual/cloud-migrate.webp "A batch in flight. A session at a permission prompt moves at once and asks again on the destination; a mid-turn one finishes first.")

Moving home works the same way in the other direction. When your laptop is under load, the resources view offers a **Free up** review that shows CPU and memory before and after and spreads sessions across machines for you.

## Limits worth knowing

Hosts cost money while they run, so a Linux host stops itself after 20 idle minutes. Waiting work, open turns, recent subagent activity, background terminals and CPU all count as busy; a session idling at a prompt does not. Work queued for a sleeping host wakes it. Only Claude Code sessions can be moved between machines, and only between a laptop and a host, not host to host. Starting and moving work needs a laptop online, though a running session keeps going with the lid closed. The host pushes with a short-lived token scoped to one repository, so opening a pull request from there needs a GitHub login on the host.

> **Why it matters.** The cloud session starts from your working state and reports back into your inbox, so moving work off the laptop stops being a context switch. The move is the quiet clever part: messages sent while a session is in transit are held, not lost, and the turn in progress is allowed to finish before the transcript moves.
