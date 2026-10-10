Most agent browsing starts in a fresh, empty browser: no cookies, no SSO, no staging login. Codecast takes the opposite route. A Chrome extension, paired once per machine, lets every agent on that machine work in the Chrome profile you already use. If your Chrome can open a dashboard behind SSO, the agent can read it. Nothing about your profile is copied or synced anywhere.

There is no browser button to press: you ask an agent in plain words ("check the checkout on staging") and watch it happen in Chrome and in the thread. Setup is once per machine. Install the Codecast extension from the Chrome Web Store, then in **Agent features** turn on the Browser card and click **Pair**; the card reads "Chrome connected". If an agent reaches for the browser before that, a **Connect your Chrome** card appears under its step with **Install extension** and **Pair**, and offers to tell the agent to carry on once it is done.

![A Chrome window with your own tabs and a red Cast tab group; the agent's background tab shows a staging checkout page with a red border, and below it the conversation row for Verify the order fix on staging: browser do, 5 steps, stopped at wait, with open tab and watch pills, a screenshot, a console TypeError and a 500 POST to /api/orders.](/blog/field-manual/browser-hero-app.webp "One flow end to end: the agent's tab sits in the red Cast group behind your own tab, its run stops at the failing step, and the console error, failed request and screenshot land in the conversation without anyone asking for them.")

## What you see in Chrome

Every agent tab opens in the background, inside a red tab group named **Cast**. Each session gets one tab and reuses it. Your window, tabs and focus stay put; agents act only on tabs they opened.

A driven page wears a thin red border (hidden from screenshots), the toolbar icon carries a CAST badge, and Chrome shows its debugging banner. When the work is done, the agent closes its tab.

![A tab strip with the user's own tabs (Inbox, Q4 roadmap, a pull request) on the left and a red Cast group on the right holding three agent tabs, with a legend mapping each tab to the claude or codex session that owns it.](/blog/field-manual/browser-tabgroup.webp "Your tabs on the left are never touched. The Cast group holds one tab per session, and each tab knows which session owns it.")

Your screen changes only when the agent needs you (you asked to see the page, or it hit a sign-in): it brings its tab forward once, says what to do, and waits.

## What you see in the thread

Each browser step is a row in the conversation with two pills:

- **open tab** raises the agent's tab in your Chrome, or offers to bring the page back if it was closed.
- **watch live** streams the tab into a pane beside the thread (or docked above it), the address flashing whenever the agent navigates.

The live view has one control that matters: **Take the wheel** sends your clicks and typing to the page, for a login the agent cannot do. **Hand back** (or `Esc`) and it carries on, signed in.

![An agent's tab showing a Linear login page with a Take the wheel button, and a message from claude asking the human to sign in so it can continue in the same tab.](/blog/field-manual/browser-wheel.webp "When a page needs a person, the agent says so. You watch the tab live from the thread, take the wheel, sign in, and hand it back with Esc.")

An agent can also offer you a page (a staging build, a failing dashboard): a chip appears beside the session title and a globe on its inbox card. Nothing opens until you click; an agent never moves what you are looking at.

## How the agent reads a page

Agents do not guess at pixels. The page is read as a short list of things you can act on, each with a ref like `#e7`, and every action names a ref (or just "find Place order, click"). After a refresh, a stale ref is found again at the same position rather than pointing at whatever moved there.

![Left, a terminal showing cast browser snapshot -i -s main output: textbox Email ref e3, textbox Card number ref e4, combobox Shipping e5, checkbox Save this card e6, button Place order e7, then cast browser click #e7. Right, the checkout page with each control labelled #e3 to #e7.](/blog/field-manual/browser-refs.webp "The agent's side, for the curious: what it reads is a short list of pressable things, and the refs on the left are the badges on the right. You never type these.")

Agents batch the steps they can see ahead into one run, which stops at the first failure and reports what ran and what never did. Waits are for text or a URL, never a fixed sleep.

## Evidence lands without asking

A screenshot renders under the step that took it. An annotated shot draws the refs on the image, so you and the agent mean the same button by `#e7`, and a phone-sized viewport shows what a phone shows. When any step fails, the row brings its own context: console errors and failed requests, newest first, plus a screenshot. Network logs, vitals and recordings are there when debugging needs them.

![A conversation titled Mobile checkout looks broken: a browser shot --annotate row with numbered labels on each control, a desktop and mobile shot side by side after viewport mobile, and a failed wait row with console errors and a 500 request.](/blog/field-manual/browser-evidence.webp "Annotated shots, the same page at phone size, and a failure that brings its own context, all as rows in the conversation.")

## Safety model

Your signed-in browser is a real grant, so the connection never leaves the machine: the extension talks only to a bridge on 127.0.0.1, and after pairing each side proves it holds the secret without sending it. An audit trail records the sites agents visit, by origin only, since full URLs carry tokens. A project can list the sites agents may browse; landing off the list is flagged.

![Diagram: cast CLI connects by websocket to a bridge host on 127.0.0.1 only; the Codecast extension in your Chrome profile connects out to the bridge and drives the Cast tabs through chrome.debugger. Text below explains HMAC pairing.](/blog/field-manual/browser-safety.webp "Everything stays on 127.0.0.1. The extension runs nothing for a host that has not proved it holds the pairing token.")

> **Why it matters.** The hard part of agent browsing was never clicking; it was being logged in, and showing the human what happened. Borrowing your real profile solves the first; evidence as a side effect of every step solves the second. If the extension is missing or asleep, the agent says what to fix and never quietly launches another browser. A session on a cloud host can borrow one site's login from your laptop (never Google's).
