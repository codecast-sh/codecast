Agents keep needing credentials halfway through a task: a Stripe test key to run the billing tests, the staging admin password, a signed-in Vercel dashboard. Without a better place, someone pastes the value into the chat, where it sits in a synced transcript and gets sent to a model, or exports it in one terminal, where no agent on another machine can use it.

The Vault is one place your team fills once. Every agent on every machine, cloud hosts included, uses what it holds, and a value never has to appear in a conversation.

## Turn it on

The Vault page is there for everyone: open **Vault** from the sidebar, or press the palette shortcut and type "vault".

For agents to use it, open **Agent features** from your account menu, pick the computer your agents run on and switch on **Vault**, under *Hands on the machine*. New sessions on that computer take credentials from the Vault from then on, and ask for the ones it lacks instead of asking you to paste them.

## The Vault page

One row per secret. Each row shows what kind it is, its name, the environment variable it fills or the site it's for, whether the team or only you can use it, when an agent last used it and from which session, and how many times agents have read it. **All**, **Team** and **Only me** at the top narrow the list, and search finds a secret by name, note, variable or site.

**Add** offers four kinds:

| Kind | What it holds | How agents use it |
|------|---------------|-------------------|
| Key | One value, such as an API key | As an environment variable for the command that needs it |
| Login | Username, password and an optional 2FA setup key | Username and password as variables, and the current 2FA code when a site asks |
| File | A whole file: a service account JSON, an SSH key | As the path of a private temporary file, removed when the command ends |
| Sign-in | A site's signed-in browser session | Loaded into the agent's browser before it opens that site |

Pasting does some of the typing for you. A `STRIPE_SECRET_KEY=sk_test_…` line fills both the variable and the value, an `otpauth://` link fills the 2FA field and the username, and **Import .env** turns a whole `.env` file into one secret per line, with a checkbox for each.

Each secret is saved either for the team, where every member and their agents can use it, or for you alone. The dialog names both choices.

Opening a row shows the secret beside the list. Values stay masked: **Reveal** shows one for 45 seconds and hides it again when you leave the window, and copy works without revealing. A login shows its live 2FA code with a countdown. A sign-in shows when it expires and where it was captured. Name, variables, sites and note are edited in place. **Activity** lists every use with the person or the session behind it, so "which agent used the production key on Tuesday" is one look.

**Rotate** replaces the value, and agents pick up the new one on their next use. **Delete** first shows what stops working: which agents lose it and which variables go empty. The activity stays after a delete.

## When an agent asks for a credential

An agent that needs something the Vault lacks asks for it in the conversation. The request shows up as a card where the command would be: the name, what kind of secret it wants, why, and a masked field. Paste the value there and press **Save**. The value goes straight to the Vault, the card collapses to a line saying it's ready and who filled it, and the agent picks up where it stopped.

![A request card in a conversation: the agent asks for stripe-test to run the billing tests, with a masked field and Save](/documentation/vault/request.webp "An agent asked for a Stripe test key. The value goes into the masked field, not the chat.")

The request also appears at the top of the Vault page and in your notifications, so you can fill it without opening the conversation. On the phone, open **Settings**, then **Vault**: open requests are at the top there too.

If you paste the value into the chat anyway, the daemon on that machine recognizes every Vault value and replaces it in the transcript with the secret's name before anything syncs. Treat that as a safety net, not a way to hand values over.

## Saving a sign-in

Some work happens behind a login: a dashboard, an admin panel, a vendor's console. Save that sign-in once and agents' browsers start signed in, on any machine.

Open **Add**, then **Sign-in**, name the site, and choose who can use it. Then pick one of two ways:

- **From my Chrome on** your laptop copies that site's sign-in out of your own Chrome on a laptop that is online. Saving it for the team asks you to confirm first, because the team then uses your account on that site.
- **Agent browser**: sign in through an agent's browser, then save it from there. The dialog shows the commands to copy.

An agent that opens a site with a saved sign-in starts signed in, and when the site refreshes its session, the agent's browser writes the newer one back, so the sign-in stays alive. Google never takes part: it keeps its own sign-in.

An agent that hits a sign-in wall can ask for a sign-in the same way it asks for a key. The card offers the same two ways.

## Projects

A repository can say which secrets it uses, by name, in `.codecast/workspace.toml`:

```toml
[vault]
STRIPE_SECRET_KEY = "stripe-test"
DATABASE_URL = "staging-db"
```

Agents in that repository then run tests and dev servers with those variables filled in, and nobody keeps a `.env` file on disk. A name the Vault doesn't hold yet shows up as a request to fill. Ask an agent to "set up the Vault map for this repo" and it will write the table for you.

## What it will and won't do

- **Values stay out of transcripts.** Agents use a secret by passing it to the command that needs it, not by printing it. When an agent runs a command that does print one, the conversation shows the command and "value hidden", never the output.
- **Every read is recorded** against the person or session that made it, and the record stays after the secret is deleted.
- **Values are encrypted at rest**, bound to their team or to you, and never sync into the app's local storage on your devices.
- **There are no per-agent permissions.** Everyone in the team, and their agents, can use a team secret. Keep anything one person should hold as **Only me**.

## For people who script

`cast vault` is the same Vault from a terminal. It lists secrets, adds them (from a hidden prompt, never a command-line argument), runs a command with secrets in its environment, prints a 2FA code, files a request, and saves a sign-in. `cast vault --help` lists every command, and `cast guide vault` prints the reference agents use.
