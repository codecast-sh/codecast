Agents keep needing credentials halfway through a task: a Stripe test key to run the billing tests, the staging admin password, a signed-in Vercel dashboard. Without a better place, someone pastes the value into the chat, where it sits in a synced transcript and gets sent to a model, or exports it in one terminal, where no agent on another machine can use it.

The Vault is one place your team fills once. Every agent on every machine, cloud hosts included, uses what it holds, and a value never has to appear in a conversation.

![The Vault page: an agent's open request at the top, then the team's secrets with their env vars and when each was last used](/documentation/vault/vault-page.webp "The Vault, with an agent's request waiting at the top.")

## Turn it on

The Vault page is there for everyone: open **Vault** under **More** in the sidebar, or search "vault" in the command palette.

For agents to use it, open **Settings**, choose **Agent Features** under *Machines*, pick the computer your agents run on, and switch on **Vault** under *Hands on the machine*. New sessions on that computer take credentials from the Vault from then on, and ask for the ones it lacks instead of asking you to paste them.

## The Vault page

One row per secret: its kind, its name, the env vars it fills or the sites it's for, and when an agent last used it and from which session. A person icon marks a secret only you can use, **2FA** one that holds a 2FA code, and a shield one set to **Ask first**. **All**, **Team** and **Only me** at the top narrow the list, and search finds a secret by name, note, env var or site.

**Add** offers four kinds, and **Import .env**:

| Kind | What it holds | How agents use it |
|------|---------------|-------------------|
| Key | One value, such as an API key | As an environment variable for the command that needs it |
| Username and password | A login, with an optional 2FA setup key | Username and password as variables, and the current 2FA code when a site asks |
| File | A whole file: a service account JSON, an SSH key | As the path of a private temporary file, removed when the command ends |
| Browser sign-in | A site's signed-in browser session | Loaded into the agent's browser before it opens that site |

![The Add to Vault dialog for a key, with name, env var, value and who can use it](/documentation/vault/add-secret.webp "Adding a key. Pasting an ENV=value line fills both fields.")

Pasting does some of the typing for you. A `STRIPE_SECRET_KEY=sk_test_…` line fills both the env var and the value, an `otpauth://` link fills the 2FA field and the username, and **Import .env** turns a whole `.env` file into one secret per line, with a checkbox for each. Each secret is saved for the team, where every member and their agents can use it, or for you alone; **Who can use it** names both.

## A secret's detail

Click a row and the secret opens beside the list.

![A secret's detail beside the list: masked value, env vars, Ask first, previous values and activity](/documentation/vault/secret-detail.webp "Values stay masked. Every use is listed under Activity.")

- **Values stay masked.** The eye reveals one, and it hides again after 45 seconds idle or when you leave the window. Copy works without revealing. A login with a 2FA setup key shows its live code with **Show 2FA code**.
- **Edit in place.** Name, env vars, sites and note change right in the panel.
- **Replace value** swaps in a new value, and agents pick it up on their next use. The old value stays for 7 days under **Previous**, with when it was replaced, by whom, and its first and last characters. **Restore** puts it back; the value it replaces moves into the list, so a wrong restore is undone the same way.
- **Activity** lists every use with the person or session behind it, so "which agent used the production key on Tuesday" is one look.
- **Delete** first shows what stops working: which agents lose it and which env vars go empty. The activity stays after a delete.
- **A browser sign-in** shows when it expires and where it was captured.

### Secrets that need a look

The right-hand column flags a secret that needs attention with a colored dot: a sign-in that has **expired** or **expires** within 3 days, a secret no agent has used since it was added (**Never used**), and one nobody has used in 90 days. **Needs attention** at the top shows the count and narrows the list to those rows.

## Ask first

Some secrets should never be used without someone saying yes: a production database, a live payment key. Open the secret and switch on **Ask first**.

From then on, the first time an agent in a session needs it, the agent stops and a decision lands in your queue: which session wants which secret, and what for, with **Approve for this session** and **Deny**. The agent waits without reading anything and continues when you approve. One approval covers that session for up to 12 hours; a new session asks again, and after a denial the next attempt asks again too. Each request, approval and denial shows in the secret's **Activity**.

![The Ask first decision in the queue, naming the session and the secret, with Approve for this session and Deny](/documentation/vault/ask-first-decision.webp "An Ask first secret waits for a person's yes.")

Switching Ask first on takes one click. Switching it off asks you to confirm, shows which agents will then read the secret without asking, and then asks for Touch ID. Revealing or copying an Ask first value asks for Touch ID too. While Ask first is on, agents cannot change the secret either: replacing, restoring, renaming, editing its env vars or sites, and deleting it all happen on the Vault page, by a person.

## When an agent asks for a credential

An agent that needs something the Vault lacks asks for it in the conversation. The request shows up as a card: the name, the kind of secret, why, and a masked field. Paste the value there and press **Save**. The value goes straight to the Vault, the card collapses to a line saying it's **Ready** and who filled it, and the agent picks up where it stopped.

![An agent's request for a key in the conversation, with a masked field and Save](/documentation/vault/request-card.webp "Fill a missing key without the value entering the conversation.")

The request also appears under **Asked for** at the top of the Vault page and in your notifications, so you can fill it without opening the conversation. On the phone, open **Settings**, then **Vault**: open requests are at the top there too.

## Pasting a key into a message

If a message you are about to send holds something that looks like a credential (an API key, a private key, a `PASSWORD=…` line), it doesn't go out yet. A bar above the message box shows the key's first and last few characters and suggests a name. Choose whether the team or only you can use it, then **Save to Vault and send**: the key goes to the Vault, and the message goes out naming the secret in place of the value, so the agent can use it without ever seeing it. **Send as is** sends the message unchanged, and **Esc** goes back to editing. The check runs when you send, never while you type.

![The bar above the message box offering Save to Vault and send for a pasted key](/documentation/vault/composer-catch.webp "A pasted key is caught before the message goes out.")

A value that reaches a conversation anyway, typed by you or printed by a command, is replaced in the transcript with the secret's name before anything syncs, because the daemon on that machine recognizes every Vault value. Treat that as a safety net. Hand values over through the Vault.

## Saving a browser sign-in

Some work happens behind a login: a dashboard, an admin panel, a vendor's console. Save that sign-in once and agents' browsers start signed in, on any machine.

Open **Add**, then **Browser sign-in**, name the site, and choose who can use it. Then pick one of two ways:

- **From my Chrome on** your laptop copies that site's sign-in out of your own Chrome on a laptop that is online. Saving it for the team asks you to confirm first, because the team then uses your account on that site.
- Or sign in through an agent's browser, then save it from there.

![The Save a sign-in dialog with the site, who can use it, and From my Chrome](/documentation/vault/save-signin.webp "Copy a site's sign-in from your own Chrome.")

An agent that opens a site with a saved sign-in starts signed in, and when the site refreshes its session, the agent's browser writes the newer one back, so the sign-in stays alive. Google keeps its own login and can't be saved this way. An agent that hits a sign-in wall can ask for a sign-in the same way it asks for a key.

## Projects

A repository can say which secrets it uses, by name, so agents run its tests and dev servers with those variables filled in and nobody keeps a `.env` file on disk. Ask an agent to "set up the Vault map for this repo" and it writes the list into `.codecast/workspace.toml`. A name the Vault doesn't hold yet shows up as a request to fill.

A project that keeps a `.env` file can commit one that names secrets instead of holding them: a line like `STRIPE_SECRET_KEY=vault://stripe-test` is filled from the Vault when an agent runs a command with that file.

## What it will and won't do

- **Values stay out of transcripts.** Agents pass a secret to the command that needs it rather than printing it. When an agent runs a command that does print one, the conversation shows the command and "value hidden", never the output.
- **Every read is recorded** against the person or session that made it, and the record stays after the secret is deleted.
- **Values are encrypted at rest**, bound to their team or to you, and never sync into the app's local storage on your devices.
- **There are no per-agent permissions.** Everyone in the team, and their agents, can use a team secret. Keep anything one person should hold as **Only me**, and switch on **Ask first** for anything an agent should use only with a person's yes.

## For agents and scripts

`cast vault` is the same Vault from a terminal: list, add from a hidden prompt, run a command with secrets in its environment, print a 2FA code, file a request, save a sign-in, restore a previous value. `cast vault --help` lists every command, and `cast guide vault` prints the reference agents use.
