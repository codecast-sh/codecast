Most browser automation for agents starts a fresh, empty browser: no cookies, no SSO, no staging login. The agent then spends its effort on sign-in walls, or you paste session tokens into its context. Codecast takes the opposite route. A Chrome extension, paired once per machine, lets every agent session on that machine work in the Chrome profile you already use. If your Chrome can open a dashboard behind SSO, the agent can read it. Nothing about your profile is copied or synced anywhere.

![A Chrome window with a red Cast tab group; the agent's background tab shows a staging checkout page with a red border, a terminal on the right shows a cast browser do flow failing at a wait step with console errors and a 500 POST, and below, the conversation row shows the same evidence inline.](/blog/field-manual/browser-hero.webp "One flow end to end: the agent's tab sits in the red Cast group behind your own tab, its run stops at the failing step, and the console error, failed request and screenshot land in the conversation without anyone asking for them.")

## What you see in Chrome

Every agent tab opens in the background, inside a red tab group named **Cast**. Each session gets one tab and keeps reusing it, so ten agents on one Chrome make ten tabs, not a hundred. Your window, your tabs and your focus stay where you left them; agents act only on tabs they opened, never on yours.

You can always tell what is being driven. A driven page wears a thin red border (hidden from the agent's screenshots), the toolbar icon carries a CAST badge, and Chrome shows its own debugging banner while a tab is attached. When the work is done, the agent closes its tab.

![A tab strip with the user's own tabs (Inbox, Q4 roadmap, a pull request) on the left and a red Cast group on the right holding three agent tabs, with a legend mapping each tab to the claude or codex session that owns it.](/blog/field-manual/browser-tabgroup.webp "Your tabs on the left are never touched. The Cast group holds one tab per session, and each tab knows which session owns it.")

Your screen only changes when the agent needs you there: you asked to see the page, or it hit something only you can do, like a sign-in or a permission prompt. Then it brings its tab to the front once, says what to do, and waits.

## What you see in the thread

Each browser step the agent takes is a row in the conversation, and each row carries two small pills:

- **open tab** raises that agent's tab in your Chrome. If the tab has since been closed, the pill offers to bring the page back instead of doing nothing.
- **watch live** streams the tab into a pane beside the thread, so you see what the agent sees as it works, with the address flashing whenever it navigates. On a narrow window, or if you prefer, the same stream docks above the transcript instead.

The live view has one control that matters: **Take the wheel**. Press it and your clicks and typing go to the page, which is how you get the agent past a login it cannot do. Press **Hand back** (or `Esc`) and the agent carries on in the same tab, signed in.

![An agent's tab showing a Linear login page with a Take the wheel button, and a message from claude asking the human to sign in so it can continue in the same tab.](/blog/field-manual/browser-wheel.webp "When a page needs a person, the agent says so. You watch the tab live from the thread, take the wheel, sign in, and hand it back with Esc.")

An agent can also hand you a page outright. When it finds something worth your eyes (a staging build, a report, a failing dashboard) it offers it, and a chip appears beside the session title, with a small globe on the inbox card so an unread session tells you it has one waiting. Nothing opens until you click: an agent never moves what you are looking at.

## How the agent reads a page

Agents do not guess at pixels. The page is read as a short list of the things you can act on (buttons, fields, links), each with a small ref like `#e7`, and every action names a ref. When the agent can name its target it skips the list entirely and says "find Place order, click". Refs survive a re-render: after a refresh, a stale ref is found again at the same position among its namesakes, rather than pointing at whatever moved into its place.

![Left, a terminal showing cast browser snapshot -i -s main output: textbox Email ref e3, textbox Card number ref e4, combobox Shipping e5, checkbox Save this card e6, button Place order e7, then cast browser click #e7. Right, the checkout page with each control labelled #e3 to #e7.](/blog/field-manual/browser-refs.webp "What the agent reads is a short list of pressable things. The refs on the left are the badges on the right.")

Agents batch the steps they can see ahead (open, fill, click, wait for "Order confirmed") into one run, which stops at the first step that fails and reports what ran and what never did. Waits are for the state the agent means, a piece of text or a URL, never a fixed sleep.

## Evidence lands without asking

You should not have to ask an agent for proof. A screenshot renders right under the step that took it. An annotated shot draws the refs onto the image, so you and the agent mean the same button by `#e7`. The agent can switch the tab to a phone-sized viewport and show you what a phone shows. And when any step fails, the row brings its own context: the page's console errors and failed requests, newest first, and a screenshot of what was on screen. Network logs, performance vitals, accessibility checks and screen recordings are there when a debugging session needs them.

![A conversation titled Mobile checkout looks broken: a browser shot --annotate row with numbered labels on each control, a desktop and mobile shot side by side after viewport mobile, and a failed wait row with console errors and a 500 request.](/blog/field-manual/browser-evidence.webp "Annotated shots, the same page at phone size, and a failure that brings its own context, all as rows in the conversation.")

## Safety model

Handing an agent your signed-in browser is a real grant, so the connection never leaves the machine. The extension talks only to a small bridge on 127.0.0.1, and pairing gives it a secret once; after that each side proves it holds the secret without ever sending it, and it never appears in agent output (which syncs off the machine). An audit trail records the sites agents visit, by origin only, since full URLs carry tokens. A project can also keep a list of sites agents may browse; a click or redirect that lands off the list is flagged, not silently allowed.

![Diagram: cast CLI connects by websocket to a bridge host on 127.0.0.1 only; the Codecast extension in your Chrome profile connects out to the bridge and drives the Cast tabs through chrome.debugger. Text below explains HMAC pairing.](/blog/field-manual/browser-safety.webp "Everything stays on 127.0.0.1. The extension runs nothing for a host that has not proved it holds the pairing token.")

> **Why it matters.** The hard part of agent browsing was never clicking; it was being logged in, and showing the human what happened. Borrowing your real profile solves the first, and making screenshots and failure context a side effect of every step solves the second. Two refusals keep it honest: if the extension is missing or asleep, the agent waits and then tells you what to fix, and it never quietly launches a different browser; and agents touch only the tabs they opened. A session on a cloud host, which has no Chrome of yours, can borrow one site's login from your laptop (Google logins are never carried).
