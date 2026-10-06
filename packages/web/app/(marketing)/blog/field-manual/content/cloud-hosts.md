Cloud agent products usually start from a clean clone of `main` in someone else's sandbox: your uncommitted change, your `.env.local`, your agent config and your logins are not there. Codecast's cloud hosts are machines in your own AWS account (Linux, or a Mac), and a session sent there starts *from the checkout you are standing in*, uncommitted and gitignored files included. Its edits mirror back to your laptop as they happen, and whole batches of sessions move between laptop and host without losing a message.

![Left, on a cream laptop background: git status shows a modified src/routes/v1.ts and an ignored .env.local, then a cloud spawn snapshots a41c9e2 plus one change and reports jx7k2pd running on ip-172-31-40-243; below, the synced worktree tree with the agent's edits. Right, on a dark host background: a checklist (woke the host, fetched, copied .env.local, agent logins pushed, worktree acquired, branch reset with v1.ts uncommitted again) and the claude session's tool calls.](/blog/field-manual/cloud-hero.webp "One cloud session, condensed: the laptop on the left, the host on the right, one conversation throughout.")

## Choosing where a session runs

A host is added once, from Devices in Settings, and then sits next to your laptops. To start a session there, flip **run in the cloud** in the composer and pick **start from**: **my checkout** (your exact working state) or **origin/main** for a clean start. Each session gets its own worktree on the host, and a sleeping host wakes itself when the session starts.

The session header then carries a chip with the machine's name. Its menu lists every machine you can use, the current one marked **running here**, and moves the session to any other; the same menu is on the phone, so you can push a session to the host from the couch.

## What arrives on the host

Your branch, unpushed commits, and uncommitted, untracked and gitignored files are captured without anything in your checkout moving, and the host restores them as uncommitted work, so the agent sees what you saw. It travels from your laptop over SSH, never through codecast's servers, and if any step fails the session fails loudly rather than quietly starting from `main`.

![Two commit graphs. Laptop: commit a41c9e2 not pushed, modified v1.ts and .env.local captured by a temporary index into a snapshot commit. Host: the same a41c9e2 on feature/checkout, with v1.ts and .env.local uncommitted again.](/blog/field-manual/cloud-spawn.webp "The snapshot carries your exact working state across, and the host restores it as uncommitted work.")

The host is set up like your laptop too: agent config and instructions, shell setup, logins for Claude, Codex, GitHub, AWS and the rest (each only while its token is live), the same tool versions. Your Anthropic API key and Google browser logins deliberately stay home. What the repo needs (Postgres, Redis, a seed script) is declared once and converges on every wake.

## A live mirror back to your laptop

**Sync with MacBook-Pro**, in the machine chip's menu, keeps a copy of the session's folder on your laptop, both ways, a few seconds behind (or **Cloud to laptop only** if you just want to watch). Open it in Cursor or VS Code from the menu, run the tests locally, or fix a line yourself and the agent sees it; the chip reads "in step" with the time of the last sync.

Dependency and build folders, media and very large files stay on their own side, listed under **Stayed on its own machine**. When both sides change the same file, only that file pauses, with **Keep the laptop's** and **Keep the cloud's**; everything else keeps flowing. Nothing lands mid-edit, and the sync pauses while the session is idle so the host can still sleep.

![The machine menu for session jx7k2pd: Synced with MacBook-Pro, both ways; one file held because it changed on both sides with Keep the laptop's and Keep the cloud's buttons; a list of what stayed on the host (node_modules, a video, a large dump); next to it four cards: Everything travels, Only the conflicting files hold, Nothing lands mid-edit, The host still sleeps.](/blog/field-manual/cloud-mirror.webp "A conflict holds one file, not the sync. Heavy and machine-specific files stay on their side.")
![The codecast app from the product film: a Codex session titled Webhook API half running on cloud-4f2a91, which opened a cast browser tab in Chrome on linux-host-1; the inbox on the right lists sessions on the laptop and the cloud host together.](/blog/field-manual/film-remote.webp "From the homepage film's Anywhere chapter: a Codex session on a cloud host sits in the same inbox as the laptop's sessions, browser tab and all.")

## Moving twenty sessions before you close the lid

Select sessions in the inbox, right-click, and choose **Move 20 sessions to** a machine; **Progress** on the toast opens the batch. A session mid-turn finishes it first, up to a wait limit you pick. Messages you send it meanwhile are held ("message waiting") and delivered on the destination. A session at a permission prompt moves at once and asks again on the other side.

Each row walks through **waiting for turn**, **stopping**, **transferring**, **handing off** and **resuming**, with a retry for any that fail. In the thread a divider marks the move ("now running on ip-172-31-40-243, was MacBook-Pro"), and the agent is told which machine it is on now. Moving home works the same way in the other direction.

![Batch mg-4k7q2z9a with five columns Fence, Wait, Quiesce, Transfer, Flip, and five sessions at different stages: one resumed on the host, one sharing a worktree pushed once, one at a prompt moving now, one mid turn finishing first with 2 messages waiting, one queued.](/blog/field-manual/cloud-migrate.webp "A batch in flight. A session at a permission prompt moves at once and asks again on the destination; a mid-turn one finishes first.")

## Limits worth knowing

A Linux host sleeps after 20 idle minutes (a session idling at a prompt does not count as busy) and queued work wakes it. Only Claude Code sessions move, and only laptop to host or back. Starting and moving work needs a laptop online, though a running session keeps going with the lid closed. Opening a pull request from the host needs a GitHub login there.

> **Why it matters.** The cloud session starts from your working state and reports back into your inbox, so moving work off the laptop stops being a context switch. The move is the quiet clever part: messages sent while a session is in transit are held, not lost, and the turn in progress is allowed to finish before the transcript moves.
