Your coding agents don't know codecast exists until something tells them. Agent features is where you decide what they learn: to look up what earlier sessions decided, hand work to another session, track work on your board, show results as charts and pages, or use your browser and your Mac. Each feature is a short set of instructions added to the agent's own setup on one computer. Switch it on and every new session there knows how to use it.

Nothing runs because a feature is on. A feature teaches an agent what it can do; the agent reaches for it when the work calls for it, or when you ask.

## Find it

In the sidebar, open **More** and choose **Agent features**. In the Classic style it is in your account menu instead. You need at least one computer connected to codecast; [Getting started](/documentation#getting-started) covers that.

![The top of Agent features: the machine picker set to this computer, Find a feature, All, On and Off, and the count of features on](/documentation/agent-snippets/agent-features-intro.webp "Agent features shows one computer at a time, with a count of what is on there.")

The page shows one computer at a time. Pick it from the machine picker at the top; the one you are on is marked *this computer*. Each machine keeps its own setup, so a feature you turn on for your laptop is not on your cloud host until you turn it on there too. A machine that is offline is marked **Offline** and its switches are disabled until it reconnects.

## The page

Features are grouped by what you get from them:

| Group | What's in it |
|-------|--------------|
| **Context** | What an agent knows before it starts: past sessions, and where each thread stands |
| **Working together** | Sessions that delegate, message each other, and bring you a decision instead of an interruption |
| **Tracking & automation** | Tasks and plans on your board, runs that fire later or on events, and pull requests seen through to merge |
| **Showing the work** | Visuals in the conversation, pages you can share, and mods that extend the app |
| **Hands on the machine** | Your browser, native apps and simulators, plus the shared typecheck and usage limit recovery |

![The Context group: Stable context, Memory and Thread State cards, each with a picture, a switch and a one-line summary](/documentation/agent-snippets/feature-group.webp "Each card shows what the feature looks like in use, its switch, and what you get. Click a card for How it works.")

- **The switch** on each card turns the feature on or off for the selected machine. Turning one on first shows what it adds to that machine and asks you to confirm; turning it off is one press. The change applies within seconds.
- **Review all**, at the top of a group with more than one feature off, lists what would switch on and asks you to confirm.
- **Find a feature** searches names and descriptions. **All**, **On** and **Off** filter the list, and the count at the right says how many are on for this machine. On a wide window the group list on the left jumps to a group and shows its count.
- **Stable context** is the one feature with three settings instead of a switch: **Solo** starts each new session with your 10 most recent sessions from the last 7 days, **Team** with the team's 15 most recent from the last 14 days, and **Off** with nothing. **All projects** applies it everywhere rather than per project.

## How it works, for each feature

Click any card to open its detail: **What you'll see** once it is on, **When agents use it**, and **Try asking** with a request to send. Many link straight to the place in the app the feature feeds, such as Tasks, Triggers or Pages, and to the full tour of the feature.

![The Memory detail: its switch, What you'll see, When agents use it, Try asking, and Read exactly what your agent reads folded at the bottom](/documentation/agent-snippets/feature-detail.webp "A feature's detail, opened from its card.")

At the bottom, **Read exactly what your agent reads** unfolds the full text the feature adds to your agent's setup. There is no hidden prompt: what you read there is what your agent reads.

Features that need a one-time step on the machine, like [Browser](/documentation/browser) (pair the Chrome extension) and [Computer](/documentation/computer) (two macOS permissions), show that step right on the card and in the detail as soon as you switch them on.

## New features

When codecast ships a feature after you joined, a slim banner naming it appears above your tabs. Click **See what's new** to open **New agent features**, which describes each one and what it writes, and click **Turn on…** to review and switch it on for every machine that is online. Turning one on or dismissing it hides the banner for that feature for good; Agent features stays the place to change your mind. New features also carry a **New** pill on their card for a while.

![The New agent features window, listing one new feature with Turn on… beside it](/documentation/agent-snippets/new-features-banner.webp "New agent features, opened from the banner.")

## What changes on your machine

- **Your agents' own instruction files, and nothing else.** Claude Code reads its instructions from a file in your home folder, and so do Codex and Grok. A feature adds one clearly marked section to each of those files that exists on the machine. Agents with no such file get nothing, so codecast never writes files no agent reads.
- **Never your repositories.** Codecast doesn't touch the instruction files inside your projects. Every project gets the features, and your repos stay clean.
- **Your own text is safe.** Codecast only ever replaces the sections it wrote. Anything you wrote yourself, above, below or between them, is left alone.
- **A few features add more than text.** Skills adds slash commands, Orchestration adds an /orchestrate command and three helper agents, and Stable context adds a step that runs when a session starts. The detail for each says exactly what it adds, and switching it off removes it.
- **Updates arrive on their own.** When codecast updates, any feature whose wording improved is refreshed in place. Features you switched off stay off.
- **New sessions pick it up.** A session that is already running keeps the instructions it started with. Start a new one to use a feature you just switched on.

## Where to go next

Each feature has its own guide: [memory](/documentation/memory), [messaging](/documentation/messaging), [thread state](/documentation/thread-state), [ambient awareness](/documentation/ambient-awareness), [forks and spawn](/documentation/forks-and-spawn), [tasks and plans](/documentation/tasks-and-plans), [triggers](/documentation/triggers), [workflows](/documentation/workflows), [orchestration](/documentation/orchestration), [skills](/documentation/skills), [the visual canvas](/documentation/visual-canvas), [published pages](/documentation/publish), [browser](/documentation/browser), [computer use](/documentation/computer) and [typecheck](/documentation/typecheck).

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The switches are greyed out | The machine is offline. Start codecast on it, or pick a machine that is online |
| An agent doesn't use a feature you just turned on | Start a new session. Running sessions keep the instructions they started with |
| A feature is on for one computer but agents on another don't know it | Pick the other machine at the top of the page and switch it on there too |

## For agents and scripts

The same switches exist on the command line: `cast install <feature>` turns one on for the machine it runs on, and `--disable` turns it off. The [CLI reference](/documentation#cli) lists them.
