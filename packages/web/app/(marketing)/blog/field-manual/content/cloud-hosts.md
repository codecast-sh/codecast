Cloud agent products usually start from a clean clone of `main` in someone else's sandbox: your uncommitted change, your `.env.local`, your agent config and your logins are not there. Codecast's cloud hosts are machines in your own AWS account (Linux, or a Mac), and a session sent there starts *from the checkout you are standing in*, uncommitted and gitignored files included. Its edits mirror back to your laptop as they happen, and whole batches of sessions move between laptop and host without losing a message.

![A new session's composer: the project row with web picked, the isolated worktree and run in the cloud switches both on, start from with my checkout picked over origin/main, and the machine chip reading Cloud Linux above the agent row.](/blog/field-manual/cloud-composer.webp "Run in the cloud, start from my checkout: the session starts on your host with the working state you have now.")

## Adding a host

Open Settings → **Devices**. The **Machines** section lists every machine running codecast, online ones first, and under the list sits **Add a cloud machine**. The dialog asks for **Linux** (general development, sleeps when idle) or **Mac** (Xcode, iOS and macOS work), then **Connect existing** for an EC2 instance you already have or **Create new**, and the instance, region and SSH key. The setup itself runs from your laptop, so the last step is **Copy setup command** and pasting it into a terminal in your project once: it installs the tools, copies your configuration and waits for the machine to come online. That is the only terminal step in this chapter.

![The Add a cloud machine dialog in Settings: Linux and Mac cards, Connect existing and Create new, fields for the EC2 instance ID, AWS region, SSH key path and AWS profile, and a Copy setup command button under Run from your project on your laptop.](/blog/field-manual/cloud-add.webp "Add a cloud machine builds the one command that sets the host up from your laptop.")

From then on the host sits in the list next to your laptops, with a panel that says what it carries: whether it is **Awake**, its instance type and what it costs per hour, **Your setup** (agent config, skills, shell and memory copied from your laptop), **Logins**, **Tools** at your versions, and **Host setup** for what a repo needs. Under it, **Sleep**, **Apply setup now** and **Save image**, so the next machine starts ready.

![Settings, Devices: the Machines section with a Cloud Linux host, Awake on a t3.medium in us-west-2 at $0.042 an hour, and rows for Your setup, Logins (aws, cloudflare, codex, convex, expo, fly, gcloud, gh and six more, with pi, cloudflare and wrangler held back because their tokens expired), Tools, and Host setup in step, above Sleep, Apply setup now and Save image buttons.](/blog/field-manual/cloud-devices.webp "The host's panel in Settings → Devices. An expired agent login is held back and named, with what to do about it.")

## Choosing where a session runs

With a host added, a new session's composer grows a **run in the cloud** switch. Turn it on and pick **start from**: **my checkout** (the branch, commit and uncommitted changes of this repo on your laptop) or **origin/main** for a clean start. Each session gets its own worktree on the host (turn off **isolated worktree** to use the host's main checkout), and a sleeping host boots itself when the session starts.

An open session's header carries a chip with its machine's name. Its menu, under "Run on device", lists the machines you can use: your laptops by name, each cloud host as **Move to** its name, and the current one marked **running here**. Pick one and the session moves there. The same menu is on the phone, so you can push a session to the host from the couch.

![The machine menu of a session running on Cloud Linux: Run on device lists three laptops (offline), Cloud Linux marked running here and Move to Mac-mini; below, Keep a copy on a laptop, in step with Sync with MacBook-Pro-182.](/blog/field-manual/cloud-machine-menu.webp "The machine chip's menu: where the session runs, where it can move, and the laptop copy.")

## What arrives on the host

Your branch, unpushed commits, and uncommitted, untracked and gitignored files are captured without anything in your checkout moving, and the host restores them as uncommitted work, so the agent sees what you saw. It travels from your laptop over SSH, never through codecast's servers, and if any step fails the session fails loudly rather than quietly starting from `main`.

![Two commit graphs. Laptop: commit a41c9e2 not pushed, modified v1.ts and .env.local captured by a temporary index into a snapshot commit. Host: the same a41c9e2 on feature/checkout, with v1.ts and .env.local uncommitted again.](/blog/field-manual/cloud-spawn.webp "The snapshot carries your exact working state across, and the host restores it as uncommitted work.")

The host is set up like your laptop too: agent config and instructions, shell setup and the same tool versions. Logins come in two kinds. Agent logins (Claude, Codex, Gemini, Grok, OpenCode, pi) and Cloudflare's go across only while their token is still live, because the host must never refresh your laptop's grant away; one that has lapsed shows as held back in the **Logins** row, and signing in again on the laptop sends it. Tool logins (GitHub's `gh`, AWS, npm, Vercel, Convex, Stripe and the like) travel whenever they are present. Your Anthropic API key and Google browser logins deliberately stay home. What the repo needs (Postgres, Redis, a seed script) is declared once and converges on every wake.

## A live mirror back to your laptop

**Sync with MacBook-Pro**, in the machine chip's menu under "Keep a copy on a laptop, in step", keeps a copy of the session's folder on your laptop, both ways, a few seconds behind (or **Cloud to laptop only** if you just want to watch). **Open in Cursor** or **Open in VS Code** from the same menu, run the tests locally, or fix a line yourself and the agent sees it; the chip reads "in step" with the time of the last sync.

Dependency and build folders, media and very large files stay on their own side, listed under **Stayed on its own machine**. When both sides change the same file, only that file pauses, with **Keep the laptop's** and **Keep the cloud's**; everything else keeps flowing. Nothing lands mid-edit, and the sync pauses while the session is idle so the host can still sleep.

![The codecast app from the product film: a Codex session titled Webhook API half running on cloud-4f2a91, which opened a cast browser tab in Chrome on linux-host-1; the inbox on the right lists sessions on the laptop and the cloud host together.](/blog/field-manual/film-remote.webp "From the homepage film's Anywhere chapter: a Codex session on a cloud host sits in the same inbox as the laptop's sessions, browser tab and all.")

## Moving twenty sessions before you close the lid

Select sessions in the inbox and use **Move to…** in the selection bar, or right-click and choose **Move 20 sessions to** a machine (a single card reads **Move to machine**). **Progress** on the toast opens Settings → **Migration**, which can also start a batch itself: pick a **Destination**, tick the **Sessions**, and press **Move to**.

A session mid-turn finishes it first, up to the wait limit set under **Sessions mid-turn** (**Transfers at once** sets how many move in parallel). Messages you send it meanwhile are held and delivered on the destination. A session at a permission prompt moves at once and asks again on the other side. Each row under **Migrations** walks through **waiting for turn**, **transferring** and **resuming**, with a retry for any that fail. In the thread a divider marks the move ("now running on ip-172-31-40-243, was MacBook-Pro"), and the agent is told which machine it is on now. Moving home works the same way in the other direction.

![Settings, Migration: a Destination section with cards for two cloud hosts (Cloud Linux and Mac-mini, online, with their session counts) and three laptops, then a Sessions list with a filter, a machine picker and a movable only box, and a Move to button at the bottom.](/blog/field-manual/cloud-migration.webp "Settings → Migration: pick a destination, tick the sessions, move them in one batch.")

## Limits worth knowing

A Linux host sleeps after 20 idle minutes (a session idling at a prompt does not count as busy) and queued work wakes it. Only Claude Code sessions move, and only laptop to host or back. Starting and moving work needs a laptop online, though a running session keeps going with the lid closed. Opening a pull request from the host needs a GitHub login there.

For scripts and agents, every step here has a command too (`cast spawn --cloud`, `cast remote sync`, `cast migrate`); the app and the CLI drive the same machinery.

> **Why it matters.** The cloud session starts from your working state and reports back into your inbox, so moving work off the laptop stops being a context switch. The move is the quiet clever part: messages sent while a session is in transit are held, not lost, and the turn in progress is allowed to finish before the transcript moves.
