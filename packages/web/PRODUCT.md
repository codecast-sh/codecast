# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Everyone on a team, with no split between power users and casual users. The owner's view: anyone worth hiring or keeping on the team runs a lot of agents, and those agents work together. So the person to design for is an engineer or lead who keeps Codecast open all day as their main workspace. They sort a long list of live agent sessions by who acts next, answer the decisions only a person can make, read and steer conversations, and work with teammates and their agents in chat, tasks, docs and calls. A new teammate has to be able to find their way around without training, but the app is built for people who use it all day.

## Product Purpose

Codecast is the workspace where a team works alongside its coding agents (Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok, Muse Spark). A background daemon syncs every agent session live from laptops and cloud hosts with nothing to set up. Chat, calls, tasks, plans, docs, pull requests, decisions and automations live in one place, and everything links back to the session that did it. Success means one person can run dozens of agents and still be in command of them: they always know what is waiting on them, and they can find out what happened and why.

## Positioning

Every object traces back to the agent session that produced it (`cast blame`, short IDs that render as live references), and agents are teammates in every surface: assignees on tasks, posters in chat, reviewers on PRs. It is not a chat client with agents bolted on, and not an agent runner with a team bolted on.

## Operating Context

- Open all day in a browser tab, the desktop (Electron) app or the PWA, usually next to terminals running agents.
- The core loop is the inbox. Sessions are grouped by state: `needs input` (a person acts), `working`, `dormant`, `done`, `idle`. The person opens one, reads it, answers or steers, and moves on.
- Keyboard-heavy use: shortcuts for labels, stash, kill, palette and navigation.
- Agents create a lot of the content (tasks, docs, pages, chat posts, decisions), so surfaces must stay readable while agent volume is high.
- Light and dark themes are both used.

## Capabilities and Constraints

- Surfaces (README): Inbox, Memory (search/ask/blame), Chat, Calls, Tasks and Plans, Docs, Pull Requests, Decisions, Automations (triggers, routines, workflows), Pages (artifacts), Org (early). The web app has 60+ routes.
- Terms: session, conversation, task (`ct-`), plan (`pl-`), trigger (`tr-`), doc, call (`cl-`), decision, label, stash, kill, flow, line.
- Stack: React + Vite + Tailwind in `packages/web`, Convex backend. The same web build ships in the desktop app.
- Enrichment queries go through `useQueryNoThrow`. A redesign must not change data contracts.
- Scope of the current redesign: the signed-in app. Marketing pages under `app/(marketing)` pick up shared tokens but keep their layouts.

## Brand Commitments

- Name: "codecast", written in lowercase in the product's own README. Logo at `docs/screenshots/logo.png`.
- Tagline in use: "Run your team and its agents in one workspace."
- Visual standard (chosen by the owner on 2026-11-07): the category standard, played straight and executed at full craft. Codecast sits alongside Linear, Slack and Superhuman, and their level of polish is the bar. Conventional and effective is the goal; no themed costume.
- One visual style in light and dark. It replaces the old Classic/Minimal split. The color-theme picker stays, with its palettes retuned to the standard.

## Evidence on Hand

- Product screenshots: `docs/screenshots/` (hero, inbox and others).
- The owner's complaints about the current UI: too much on screen (badges, pills, chips, banners and counts competing), inconsistent across pages, too many features in the navigation, and a generic AI-SaaS look.

## Product Principles

1. **What's waiting on me comes first.** Every surface makes clear what needs a person's action before anything else.
2. **Fewer places, each complete.** Prefer a smaller set of surfaces that each fully do their job over many partial routes in the navigation (the repo's PR-product-1 and PR-product-2).
3. **One way to do a thing.** The same object, action or state looks and behaves the same on every page.
4. **Concepts mean what they say.** Labels and states match what the system actually does (PR-product-6).
5. **Agent volume must not become noise.** Show status and metadata only when they change what the person does next.
