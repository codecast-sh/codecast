Codex Cloud runs Codex tasks on OpenAI's machines, against a GitHub repository, on your ChatGPT plan. Codecast brings those tasks into your inbox as ordinary sessions, and lets you start and steer new ones from the composer: send follow-ups, ask for several attempts, open a pull request, or apply a task's changes to the checkout on your computer.

A task runs on OpenAI's machines, but one of your computers does the talking: the browser can't reach Codex Cloud by itself, so codecast drives it from a computer of yours that is signed in to Codex. Your Codex sign-in never leaves that computer.

## Connect Codex

1. Open **Settings → Provider Keys**. The **Codex Cloud** row at the bottom says whether a computer is signed in.
2. Click **Connect Codex**, then **Sign in to Codex**. Codex opens its sign-in page in the browser on that computer; sign in with the ChatGPT account your tasks run on. On a computer with no browser, such as a cloud machine, use **Sign in with a code** instead and enter the code it shows.
3. The dialog reads *signed in to Codex as …* with your plan, and the row reads **Codex connected**.

![The Codex Cloud row in Provider Keys](/documentation/codex-cloud/provider-row.webp "Codex Cloud runs on the computer's Codex sign-in, your ChatGPT plan, not on an API key.")

![The Connect Codex dialog once a computer is signed in](/documentation/codex-cloud/connect-codex.webp "Connect Codex once signed in. The account is shown here only; the sign-in itself stays on the computer.")

**Set up an environment for each repository.** Codex Cloud runs a task in an environment made for its repository, under [Codex → Environments](https://chatgpt.com/codex/cloud/settings/environments) on chatgpt.com. If you have several for one repository, pin the one you want. Without one, your first message waits and its card links to that page; it goes out on its own once the environment exists.

## Bring your existing tasks in

**Settings → Sync & Privacy → Sync Codex Cloud tasks** is off to start with. Off, codecast shows only the tasks you start from codecast. On, it also brings in every task on your account from the last 30 days, including ones you started on chatgpt.com.

Each task becomes a Codex session with its title, repository, branch and pull request. Its transcript shows the prompt, Codex's reasoning, each command with its output, the answer and the diff. Codex Cloud doesn't stream: while a turn runs, the session shows Codex's latest progress line, and the whole turn appears when it ends.

## Start a task

In the composer, pick Codex as the agent and switch on **run in OpenAI's cloud**, then choose **ChatGPT plan**. Two more controls appear:

- **ask**: Codex reads the repository and answers, without changing code or opening a pull request.
- **attempts** (1 to 4): Codex makes several attempts at your first message.

The task starts from your checkout's branch if that branch is on GitHub, otherwise from the repository's default branch. Codex works from GitHub, so commits you haven't pushed aren't there; the transcript says so under the first prompt.

Every later message is a follow-up. A message sent while a turn is still running waits and goes out when the turn ends. Stopping the session cancels the running turn, and every attempt with it.

## Compare attempts

```figure
AttemptsFigure
Three attempts at one prompt become three branches of one session. A follow-up continues the attempt it was sent on.
```

Each attempt becomes a branch of the session. Under the shared prompt, a row of chips (**Attempt 1**, **Attempt 2**, …) switches between them, with a count and an unread dot on each. **Switch attempt** in the session menu, or the branch map in the header, does the same.

## Pull requests and your own checkout

The **Codex Cloud** chip in the session header holds the task's actions (they are also in the session menu and the command palette):

| Action | What it does |
|--------|--------------|
| **Open on chatgpt.com** | Opens the task on chatgpt.com |
| **Create draft PR** | Opens a draft pull request with this attempt's changes. A toast links to it, and the session's branch and pull request follow |
| **Apply locally** | Writes this attempt's changes into the repository's checkout on your computer, uncommitted. It refuses if you have local edits to a file the change touches, and says so if the checkout already has the changes |
| **Archive** / **Unarchive** | Hides the task on chatgpt.com, or brings it back. The session stays in codecast either way |

An ask task doesn't change code, so its PR and apply actions are off.

## When Codex Cloud can't go on

When something stops Codex Cloud, a word appears beside the composer switch and the session chip, and a message you send waits with a card that says why. It goes out on its own once the cause clears.

| You see | What it means | What to do |
|---------|---------------|-----------|
| **not connected** | The computer has no Codex sign-in, or it expired | Click **Connect Codex** on the card and sign in again |
| **needs setup** | The repository has no Codex environment | Create one under Codex → Environments |
| **limited** | A window of your ChatGPT plan's Codex limits is used up | Wait for the reset; the card counts down. Running tasks keep syncing |
| **no access** | Your ChatGPT Business or Enterprise workspace keeps Codex Cloud off for you | Ask a workspace owner to turn on *Use Codex in the cloud* for you. Signing in again won't help |
| **paused** | Codex Cloud changed in a way codecast can't read yet | Nothing to do: codecast checks again every few minutes and resumes on its own |

A waiting message's card also offers **Start on API key instead**, which runs it on the other lane below.

## The API key lane

The composer's other choice under **run in OpenAI's cloud** is **API key**. It runs the session on the OpenAI Agents API, billed to the OpenAI key in **Settings → Provider Keys** at API rates plus sandbox time. It streams as it works, but it reaches public GitHub repositories only and can't push, open a pull request or apply changes. Its sessions sync separately, under **Sync OpenAI Agents API sessions**.

## Good to know

- Tasks count toward your ChatGPT plan's Codex limits, the same ones the usage meter in the header shows.
- Codecast never refreshes your Codex sign-in, because that would sign out the Codex you run yourself. When it expires, sign in again from Settings.
- Codex Cloud has no public API, and OpenAI can change it without notice. When that happens codecast pauses rather than guessing, and resumes once it can read Codex Cloud again.
- Reading a task in codecast doesn't mark it read on chatgpt.com.
- A Codex environment's variables and secrets are never stored or shown by codecast. What syncs is the task: its transcript, title, branch and pull request.
