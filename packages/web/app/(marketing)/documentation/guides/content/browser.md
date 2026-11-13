An agent that changes a web app should look at the result, and the pages worth looking at usually sit behind a login. With the Browser feature on, your agents work in the Chrome you already use, so your logins come along: staging, an admin panel, a dashboard behind single sign-on. Each agent gets its own tab in the background. Your tabs, windows and keyboard stay yours.

What the agent sees comes back to the conversation. Screenshots appear inline, and when a page misbehaves the agent reports the errors the page logged and the requests that failed, so you can read the cause without opening the page yourself.

![The agent's answer in the conversation, with its browser steps and screenshot thumbnails above it](/documentation/browser/conversation.webp "Each browser step sits above the reply, with its screenshots, watch live, and the tab it used.")

## Turn it on

You need desktop Chrome and codecast running on the same computer as your agents ([Getting started](/documentation#getting-started) covers connecting a computer).

1. Open **Settings** and choose **Agent Features** under *Machines*. The page shows one computer at a time; pick the one your agents run on.
2. Find **Browser** under *Hands on the machine*, switch it on, and confirm with **Turn on Browser**.
3. The card lists the two steps left. **Add to Chrome** installs Codecast from the Chrome Web Store, in the Chrome profile you want agents to use. **Pair** opens the extension in Chrome, where you click **Pair** once more.
4. The card's footer turns green and reads *Chrome connected*.

![The Hands on the machine section of Agent features, with Browser switched on and Chrome connected](/documentation/browser/agent-features.webp "Browser and Computer live under Hands on the machine, one computer at a time.")

Repeat this on each computer you use. If an agent reaches for the browser before setup is done, the same steps appear as a card under its step in the conversation, with a **Tell the agent to continue** button once Chrome is connected, so you can finish setup without leaving the conversation.

![The browser setup card under an agent's step, with Add to Chrome and Pair](/documentation/browser/setup-card.webp "Setup can finish right in the conversation.")

Click **How it works** on the card to see what the feature adds and a request to try.

![The Browser feature's detail: what you'll see, when agents use it, and a request to try](/documentation/browser/browser-feature.webp "The Browser detail. Its switch turns it on for the selected computer.")

## Ask for it in plain words

Mention a page, or ask for something only a page can show:

- "Open the settings page, change the theme, and show me a screenshot."
- "Reproduce the checkout bug on staging and tell me what the console says."
- "Check that the new pricing table renders on the marketing site."
- "Read last week's invoices in the billing dashboard and total them."

Agents that change a web app also check their own work this way without being asked: open the page, look, fix, look again.

## What you see in Chrome

```figure
CastTabsFigure
Your tabs stay where you left them. Each agent session works in one background tab inside the red Cast group.
```

- **One tab per session, in the background.** Agent tabs open inside a red tab group called **Cast**. They never take focus, and a tab you open yourself is moved out of the group so agents never touch it.
- **You can tell when a tab is being driven.** The page wears a thin frame, a pointer follows the agent's clicks, and Chrome shows its own notice that Codecast is debugging the browser. The frame and pointer are hidden from the agent's screenshots.
- **Agents only touch their own tabs.** A session cannot read, close or navigate your tabs or another session's.
- **Tabs are cleaned up.** An agent closes its tab when it is done, and a tab left behind by a finished session is closed for it.

## What you see in codecast

Every browser step lands in the conversation as a small row above the agent's reply:

| On the row | What it does |
|------------|--------------|
| Screenshot thumbnails | Click one to see it full size |
| **open tab** | Brings the agent's tab to the front in your Chrome |
| **watch live** | Opens the agent's tab in a pane beside the conversation, so you can watch it work |
| **reopen tab** | Shows when the tab was closed. Click to bring the page back |

![The watch live pane beside a conversation, showing the agent's tab as it works](/documentation/browser/watch-live.webp "watch live shows the agent's tab beside the conversation.")

An agent can also offer you a page: a chip appears next to the session title, and clicking it opens the page in a pane beside the conversation. It never opens on its own, because an agent should not move what you are looking at. In the Mac app this pane loads any site, including ones that refuse to be embedded in a web page.

## What it will and won't do

- **It uses your Chrome, never a copy.** No profiles or cookies are copied or synced anywhere. If the extension is missing or asleep, the agent waits for it and tells you what to fix. It never quietly starts a different browser.
- **Sign-ins stay with you.** When a page asks for a login, the agent opens it in your Chrome and asks you to sign in there, then carries on in the same tab. Logins you keep in the [Vault](/documentation/vault) can start its tab signed in.
- **Some pages are off limits.** Chrome does not let any extension drive its own pages (`chrome://` settings, the Chrome Web Store). The agent hands you the link and the exact steps, and carries on with the rest.
- **Leaving a mark waits for you.** Agents read, click through and check pages freely. Submitting a form, sending a message, buying something or changing account settings happens only when you asked for it.
- **A project can fence it in.** A team can limit which sites agents may visit for a project, and every site an agent lands on is recorded.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The card says Chrome is not connected | Click **Pair again** on the Browser card. If Chrome is closed, pairing opens it |
| The agent says the extension is asleep | Reload Codecast at `chrome://extensions`, then tell the agent to continue |
| Agents open tabs in the wrong Chrome profile | Pair from the profile you want. Keep Codecast enabled in only one profile |
| A session on another computer can't reach your Chrome | Chrome must run on the same computer as the session. Turn Browser on for that computer too |

For anything inside a native Mac app rather than a web page, such as a file picker, System Settings or Slack, see [Computer use](/documentation/computer).

## For agents and scripts

Agents drive the tab with `cast browser` (open, snapshot, click, type, shot). You never need to type it; `cast guide browser` prints the reference agents read.
