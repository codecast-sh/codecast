# Codecast facts

What any agent may say about Codecast in public: posts, replies, docs, blog posts, ads, outreach, sales mail. If a claim is not here and you cannot point to the code or page that proves it today, do not make it. When you find a fact here that has gone stale, fix it in this file in the same change, with the date and the source you checked.

Voice and wording rules are in [voice.md](voice.md).

Last checked: 2026-11-14.

## What it is

- Codecast is one workspace for a person or a team and their coding agents. A daemon on each machine watches the agent sessions you already run and syncs them to an inbox you can steer from web, desktop and phone, with search and memory over all of it.
- One person using it alone is a full use case. Teams add shared memory, a team feed and sessions shared across members. Never describe it as team only.
- Open source, MIT license (`LICENSE`). Self-hostable (`docs/SELF-HOSTING.md`).

## Agents it works with

Source: `packages/shared/contracts/agentClients.ts` (`AGENT_CLIENTS`).

- Claude Code, Codex, Cursor, Gemini, OpenCode, pi and Grok Build (the support page and changelog list these).
- Muse Code works in the app but has not been announced: leave it out of public copy until the changelog names it.
- Threads started in T3 Code sync with no setup, because T3 Code writes the same Claude and Codex transcripts.
- Say "works with the agents you already run". Do not claim an agent not on this list.

## Apps and platforms

Source: `packages/web/app/(marketing)/download/`.

- Web app at codecast.sh.
- macOS desktop app (Apple Silicon).
- iOS app with push notifications. There is no Android app: do not claim one.
- CLI (`cast`) on macOS, Linux and Windows (Windows runs it inside WSL).

## Pricing

Source: `packages/web/app/(marketing)/pricing/page.tsx`.

- Free for individuals, forever: unlimited sessions, every agent, full sync, all apps, self-hosting.
- Team: $20 per seat per month, early access by request. There is no self-serve billing yet.
- Enterprise: contact (SSO and SCIM, audit export, supported self-hosting).
- Codecast never resells or marks up model usage. Your Claude, OpenAI and Gemini plans stay yours.
- In short replies on social, say only "free for individuals".

## Features that exist today

Each has a page at codecast.sh/features/<slug> (`packages/web/app/(marketing)/features/catalog.ts`).

| Feature | What you can say | Page |
|---|---|---|
| Inbox | Every session on every machine in one list, sorted by who acts next: needs input, working, idle | / |
| Memory | Search and ask across every past session; `cast blame` traces a line of code to the conversation that wrote it | /features/memory |
| Spawn and fork | Delegate to a new session, branch a conversation, switch agent or model mid-session | /features/agents |
| Triggers | Work that runs later: on a schedule, on a PR comment, on an event | /features/triggers |
| Flows | Every change takes the same path: pull request, CI and review, merge, deploy; it asks a person only when the change edits CI | /features/flows |
| Decisions | One queue for the calls only a person can make, answerable from the phone | /features/decisions |
| Pull requests | A PR is owned by the session that opened it; review comments and red checks wake it | /features/pull-requests |
| Browser | Agents drive your own Chrome in a background tab | /features/browser |
| Computer | Agents use native Mac apps through the accessibility tree | /features/computer |
| Publish | A URL for anything an agent makes: report, dashboard, mockup | /features/publish |
| Calls | Team calls transcribed by speaker; agents read them and file what was agreed | /features/calls |
| Cloud hosts | Run sessions on your own server, started from your laptop checkout | /features/cloud |
| Org | Roles your agents work inside, with daily caps on work and tokens | /features/org |
| Mods | Small modules that add panes, commands and live object cards to the app | /features/mods |

## Numbers you may use

- Ashot runs about 50 agent sessions a day (his X bio). Say it only as his number, in his voice.
- Nothing else: no user counts, no team counts, no revenue, no growth rates, no GitHub stars unless you read the number that day and say when.

## Never say

- Customer or company names, logos, "trusted by", testimonials. There are none we may cite.
- That Codecast "manages" agents as the headline. Lead with seeing, steering and remembering them.
- That a feature is coming, unless it is on the public changelog.
- Anything negative about another tool (T3 Code, Conductor, Claude Squad, Omnara, Anthropic's or OpenAI's apps). If another tool fits someone's need better, say so.
- "The operating system for AI coding agents", "Your AI coding sessions, accessible everywhere" (retired headlines).
- Security or compliance claims beyond what `/security` says. Route security questions to the CMO session.
