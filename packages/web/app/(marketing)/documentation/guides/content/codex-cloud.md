Codex Cloud runs Codex tasks on OpenAI's machines, against a GitHub repository, on your ChatGPT plan. Codecast syncs those tasks into your inbox as Codex sessions, and starts and drives new ones from the composer: follow-ups, several attempts, pull requests, and applying a task's changes to your own checkout.

Codex Cloud has no public API. Codecast speaks the same private API OpenAI's own `codex cloud` command uses, from your computer, with the sign-in `codex login` saved there. A second way to run Codex in the cloud, the OpenAI Agents API, is public and billed to an API key. It is covered at the end.

```bash
npm i -g @openai/codex        # the Codex CLI, if this computer doesn't have it
codex login                   # sign in with ChatGPT (the browser opens)
codex login --device-auth     # no browser here: open the printed link elsewhere
```

## Setup

**Sign in on the computer that drives the tasks.** A cloud task is driven by one of your computers, because the browser cannot call the Codex API itself. That computer needs a ChatGPT sign-in for Codex: run `codex login` there, or open Settings, Provider Keys, and press "Connect Codex" on the Codex Cloud row (it reads "Codex connected" once a sign-in is there), which runs `codex login` in a pane on that computer and shows the account and plan once it lands. A Codex login made with an API key does not count, since Codex Cloud runs on the ChatGPT plan.

**Codecast only reads that sign-in.** It reads `~/.codex/auth.json` and never refreshes or rewrites it. Refreshing would rotate the token out from under any `codex` you have running. When the access token expires, the computer stops reading Codex Cloud, Settings says "The Codex sign-in on <computer> expired", and a message you send waits for you to sign in again.

**Create an environment for each repository.** Codex Cloud runs a task in an environment set up for its repository, at [Codex, Settings, Environments](https://chatgpt.com/codex/cloud/settings/environments) on chatgpt.com. Codecast uses the environment made for the repository, else any environment that lists it, and a pinned one first: to pick among several, pin the one you want. The transcript names the environment under the first prompt. With none, the message is held and its card links to the environments page; the message goes out on its own once one exists.

## What syncs

Settings, Sync & Privacy, "Sync Codex Cloud tasks" is off by default. Off, codecast mirrors only the tasks it started. On, it also imports every task on the account that changed in the last 30 days, including ones you start on chatgpt.com.

Each task becomes a Codex session with its title, its repository, and the branch and pull request it made. A session is placed in this computer's checkout of the task's repository when there is one. The daemon polls every 5 minutes, and every 30 seconds while a task runs or right after you send it a message.

A task's transcript shows the prompt, the reasoning, each command with its output, the answer and the diff. New tasks record their work as Codex app-server events, and codecast renders them with the same parser it uses for Codex on your own machine. Older tasks keep a work log in another format, and that renders as the same rows. Codex Cloud does not stream: while a turn runs, the session shows Codex's latest progress line, and the whole turn appears when it ends.

The mirror lives under `~/.codecast/codex-cloud/<task id>/`, readable only by your user, since a task's command output can include whatever its commands printed. When two of your computers are signed in to the same account, one of them hosts each task's session and syncs it, so nothing is written twice.

## Starting and driving a task

In the composer, pick Codex and turn on "run in OpenAI's cloud", then "ChatGPT plan". Two more controls appear:

- **ask** runs the task in ask mode: Codex reads the repository and answers, without changing code or opening a pull request.
- **attempts** (1 to 4) has Codex make several attempts at the first message.

The task starts from your checkout's branch when that branch is on GitHub, else from the repository's default branch. Codex clones from GitHub, so commits you have not pushed are not there, and the transcript says so under the first prompt.

Every later message is a follow-up on the task. A message sent while a turn is still running is held and goes out when the turn ends. Stopping the session cancels the running turn. Codex cancels a whole task at once, so attempts running side by side stop together.

## Attempts

Each attempt beyond the first becomes a branch of the session, forking at the prompt they share. Switch between them under that prompt. A message sent on a branch continues that attempt, and the task's own line stays on attempt 1.

## Pull requests and applying changes

The session header has the task's actions:

- **Create PR** opens a draft pull request from the line's changes, without Codex's label. Its link appears in the thread once Codex has opened it, and the session's branch and pull request follow.
- **Apply** writes the line's changes into this computer's checkout of the repository with `git apply`, at the checkout's root, uncommitted. It refuses when you have local changes to a file the diff touches, and says so when the checkout already holds the line's changes. Codecast applies the diff Codex recorded itself, so no Codex CLI runs on your sign-in.
- **Archive** and **Unarchive** hide the task on chatgpt.com, or bring it back. The session stays in codecast either way, and one archived or brought back on chatgpt.com shows that here too.

## Limits

Codex Cloud tasks count toward your ChatGPT plan's Codex limits, the same windows as the Codex usage meter in the header, which the card names with their span ("Session (5h)", "Week (7d)"). When Codex refuses a request with a limit, codecast reads the plan's usage. If a window is used up, the held message's card names it, the composer and the session's header show "limited", and Settings and the card count down to the reset in your own clock. New tasks and messages wait for that reset, while syncing goes on: a task that is already running keeps updating. Otherwise Codex is rate limiting the requests themselves: codecast waits as long as Codex says, or backs off from one minute up to 30 minutes, for syncing and held messages alike, and Settings and the header say that nothing syncs until then.

## Workspaces without Codex Cloud

A ChatGPT Business or Enterprise workspace can keep Codex Cloud off for some people. Codex then refuses the computer's requests, and codecast shows "Codex Cloud is not enabled for you in this ChatGPT workspace" in Settings and on the held message, and "no access" beside the composer's switch and in each Codex Cloud session's header. Your Codex sign-in is fine, so Settings still shows Codex as connected: signing in again does not help. A workspace owner turns on "Use Codex in the cloud" in the workspace's settings, or, where roles are custom (RBAC), grants that permission to your role ([OpenAI's admin setup guide](https://learn.chatgpt.com/docs/enterprise/admin-setup)). Until then the computer asks Codex once per poll and says nothing more. The first answer that lets the account in resumes syncing. A refusal of one task, rather than of the account, affects only that task.

## When Codex Cloud changes

The API is private, and OpenAI can change it without notice. Codecast checks every answer against the fields it reads. When a field it depends on goes missing or changes type, or Codex keeps answering in ways it should not (three unexpected errors in a row), codecast does not guess. It pauses Codex Cloud on that computer:

- Settings says "Codex Cloud changed in a way codecast can't read yet. Syncing on <computer> is paused and checks again every 5 minutes", and the composer and each Codex Cloud session's header show "paused".
- Nothing syncs and nothing is sent. A message you send is held with a card that says the same.
- The daemon logs a warning naming the request and field that broke, which reaches codecast's server logs.
- Every 5 minutes it asks again, reading what broke. The first check that reads cleanly resumes syncing and sends what was held. A single task that keeps failing while other tasks read cleanly does not hold the rest: it waits on its own schedule, with a warning naming it, while the others sync.

An outage is not a change: server errors, a lost network and a proxy's challenge page are retried as usual. A new task is the one exception to holding: if Codex answers a request to create a task in a shape codecast cannot read, the task may already exist, so the message is not sent again. Its card links your [Codex tasks](https://chatgpt.com/codex) to look for it there.

## The OpenAI Agents API instead

The composer's other lane, "API key", runs the session on the OpenAI Agents API. It needs an OpenAI API key in Settings, Provider Keys, and syncs separately under "Sync OpenAI Agents API sessions". It is billed to the key at the model's API rates plus sandbox time; when the account runs out of credit, its card says so and links OpenAI's billing page. It streams as it works. Its sandbox clones the repository from GitHub without credentials, so it reaches public repositories only, and nothing leaves the sandbox: no push, pull request or apply. A message held for a Codex Cloud problem can move to this lane from its card, and back.

## Privacy

Your Codex sign-in never leaves your computer. The daemon there calls Codex with it, and its tokens never reach codecast's servers; only the account's email and plan are shown, in Settings. A Codex environment carries its environment variables and secrets in plain text. Codecast keeps only an environment's ID, label, machine, repository names and default branch, and never stores, logs, syncs or shows the rest. What syncs is the task itself: its transcript, title, branch and pull request, like any other session.

## Limitations

- The API is private. A change OpenAI makes can pause syncing until codecast is updated.
- Nothing streams. A running turn shows only its latest progress line.
- Tasks run against GitHub repositories, and Apply needs a checkout of the repository on the computer.
- Codecast never refreshes the Codex sign-in. An expired one means running `codex login` again.
- Turning sync on imports tasks from the last 30 days, not older ones.
- Reading a task in codecast does not mark it read on chatgpt.com.
- Tasks `@codex` starts from GitHub, Linear or Slack list with the rest, but codecast has not been tested with them yet, and a code review task may not render.
- Codecast is tested with Codex Cloud's container environments. OpenAI's newer published VM environments had not reached the account it was tested on; the official `codex cloud` command finds environments the same way codecast does.
