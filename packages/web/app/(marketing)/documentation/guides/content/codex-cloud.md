Codex Cloud runs Codex tasks on OpenAI's machines, against a GitHub repository, on your ChatGPT plan. Codecast brings those tasks into your inbox as ordinary sessions, and lets you start and steer new ones from the composer: send follow-ups, ask for several attempts, open a pull request, or apply a task's changes to the checkout on your computer.

A task runs on OpenAI's machines, but one of your computers does the talking: the browser can't reach Codex Cloud by itself, so codecast drives it from a computer of yours that is signed in to Codex. Your Codex sign-in never leaves that computer.

## Connect Codex

1. Open **Settings** and choose **Provider Keys** under *Machines*. The **Codex Cloud** row says whether the selected computer is signed in.
2. Click **Connect Codex**, then **Sign in to Codex**. Codex opens its sign-in page in the browser on that computer; sign in with the ChatGPT account your tasks run on. On a computer with no browser, such as a cloud machine, use **Sign in with a code** and enter the code it shows.
3. The dialog says the computer is signed in to Codex, with your account and plan, and the row's button reads **Codex connected**.

![The Codex Cloud row in Provider Keys](/documentation/codex-cloud/provider-row.webp "Codex Cloud runs on the computer's Codex sign-in, not on an API key.")

![The Connect Codex dialog once a computer is signed in](/documentation/codex-cloud/connect-codex.webp "The sign-in itself stays on the computer.")

**Set up an environment for each repository.** Codex Cloud runs a task in an environment made for its repository, under [Codex → Environments](https://chatgpt.com/codex/cloud/settings/environments) on chatgpt.com. If you have several for one repository, pin the one you want. Without one, your first message waits and its card links to that page; it goes out on its own once the environment exists.

## Bring your existing tasks in

**Settings → Sync & Privacy → Sync Codex Cloud tasks** is off to start with. Off, codecast shows only the tasks you start from codecast. On, it also brings in every task on your account from the last 30 days, including ones you started on chatgpt.com.

Each task becomes a Codex session with its title, repository, branch and pull request. Its transcript shows the prompt, Codex's reasoning, each command with its output, the answer and the diff. Codex Cloud doesn't stream: while a turn runs, the session shows Codex's latest progress line, and the whole turn appears when it ends.

## Start a task

In a new session's composer, pick Codex as the agent. Open the menu that says where the session runs and choose **OpenAI's cloud**. More controls appear beside it:

- **with**: **ChatGPT plan** runs on Codex Cloud. **API key** is the other lane, described below.
- **ask**: Codex reads the repository and answers, without changing code or opening a pull request.
- **attempts** (1 to 4): Codex makes several attempts at your first message.

![The new-session composer set to run in OpenAI's cloud on the ChatGPT plan, with ask and attempts](/documentation/codex-cloud/composer.webp "Run in OpenAI's cloud, on your ChatGPT plan, with three attempts.")

The task starts from your checkout's branch if that branch is on GitHub, otherwise from the repository's default branch. Codex works from GitHub, so commits you haven't pushed aren't there; the transcript says so under the first prompt.

Every later message is a follow-up. A message sent while a turn is still running waits and goes out when the turn ends. Stopping the session cancels the running turn, and every attempt with it.

## Compare attempts

```figure
AttemptsFigure
Three attempts at one prompt become three branches of one session. A follow-up continues the attempt it was sent on.
```

Each attempt becomes a branch of the session. Chips under the shared prompt switch between them, with an unread dot on each. **Switch attempt** in the session menu opens the branch map, which does the same.

## Pull requests and your own checkout

The **Codex Cloud** chip in the session header holds the task's actions. They are also in the session menu and the command palette.

![The Codex Cloud chip's menu in a session header](/documentation/codex-cloud/chip-menu.webp "The task's actions live on the Codex Cloud chip.")

| Action | What it does |
|--------|--------------|
| **Open on chatgpt.com** | Opens the task on chatgpt.com |
| **Create draft PR** | Opens a draft pull request with this attempt's changes. A toast links to it, and the session's branch and pull request follow |
| **Apply locally** | Writes this attempt's changes into the repository's checkout on your computer, uncommitted. It refuses if you have local edits to a file the change touches, and says so if the checkout already has the changes |
| **Archive** / **Unarchive** | Hides the task on chatgpt.com, or brings it back. The session stays in codecast either way |

An ask task doesn't change code, so its PR and apply actions are off.

## When Codex Cloud can't go on

When something stops Codex Cloud, a word appears beside the composer control and on the session chip, and a message you send waits with a card that says why. It goes out on its own once the cause clears.

| You see | What it means | What to do |
|---------|---------------|-----------|
| **not connected** | The computer has no Codex sign-in, or it expired | Click **Connect Codex** on the card and sign in again |
| **needs setup** | The repository has no Codex environment | Create one under Codex → Environments |
| **limited** | A window of your ChatGPT plan's Codex limits is used up | Wait for the reset; the card counts down. Running tasks keep syncing |
| **no access** | Your ChatGPT Business or Enterprise workspace keeps Codex Cloud off for you | Ask a workspace owner to turn on *Use Codex in the cloud* for you. Signing in again won't help |
| **paused** | Codex Cloud changed in a way codecast can't read yet | Nothing to do: codecast checks again every few minutes and resumes on its own |

A waiting message's card also offers **Start on API key instead**, which runs it on the other lane.

## The API key lane

**API key** under **with** runs the session on the OpenAI Agents API, billed to the OpenAI key in **Settings → Provider Keys** at API rates plus sandbox time. It streams as it works, but it reaches public GitHub repositories only and can't push, open a pull request or apply changes. Its sessions sync separately, under **Sync OpenAI Agents API sessions**.

## Good to know

- Tasks count toward your ChatGPT plan's Codex limits, the same ones the usage meter in the header shows.
- Codecast never refreshes your Codex sign-in, because that would sign out the Codex you run yourself. When it expires, sign in again from Settings.
- Codex Cloud has no public API, and OpenAI can change it without notice. When that happens codecast pauses rather than guessing, and resumes once it can read Codex Cloud again.
- Reading a task in codecast doesn't mark it read on chatgpt.com.
- A Codex environment's variables and secrets are never stored or shown by codecast. What syncs is the task: its transcript, title, branch and pull request.
