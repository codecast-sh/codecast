A pull request lives on GitHub, and the agent that wrote it lives in a conversation. Usually a person sits between them, copying review comments into a prompt and telling the agent when a check went red. In codecast every pull request in a connected repository has a page with its checks, reviews and threads, and the session that opened it stays attached as its **shepherd**. When a reviewer asks for changes or a check fails, that session wakes up, fixes it, pushes, and answers on the thread.

Issues work the same way. Connect Linear or GitHub Issues and each issue becomes a codecast [task](/documentation/tasks-and-plans) that stays in step with the original.

![A pull request page in codecast](/documentation/shots/pull-request.webp "A pull request with its shepherd, linked sessions and task, checks, review and merge state.")

## Turn it on

1. Open **Settings**, **Integrations**, connect GitHub and give the codecast app access to your repositories. Pull requests already open there come in when you connect.
2. Open **Agent features** (under **More** in the sidebar), pick the computer your agents run on, and switch on **Pull requests** under **Tracking & automation**.

![The Pull requests card in Agent features](/documentation/pull-requests/feature.webp "Click How it works on the card for what it adds and a request to try.")

Reviews with a verdict go out under your own GitHub name, so your account needs GitHub connected too. Without it, codecast says so and offers to connect, or you can review on github.com.

## Ask for it

- "Open a pull request for this and look after it until it merges."
- "Review PR 482 and request changes if the migration is unsafe."
- "Answer the open review threads on my pull request and resolve the ones you fixed."
- "Why is CI red on the webhook retries PR? Fix it."
- "Merge it once checks are green." (Agents never merge unless you ask.)

## The pull request page

Open a pull request from a conversation, a task, or **Code** in the sidebar. The header shows its state, author and branches, the **Shepherd** line, and the sessions and tasks linked to it. Below that, **Checks**, **Review**, **Merge**, **Open comments** and **Diff** sit at a glance, above tabs for **Conversation**, **Files**, **Commits** and **Checks**. The arrow next to the number opens it on GitHub.

![The top of a pull request page](/documentation/pull-requests/header.webp "Checks passed, one open comment, and the shepherd line above the four tabs.")

### Review it yourself

A review in codecast works like one on GitHub, and the result goes to GitHub:

1. In **Files**, hover a line and press **+** to write a note. Choose **Start a review** to hold it, or **Post now** to send it straight away.
2. Held notes are yours alone until you finish. A bar at the bottom of the page counts them: *2 notes not sent yet*.
3. Click **Review** (or press **r**). Your notes are listed, each linking back to its line. Add a summary, pick **Comment**, **Approve** or **Request changes**, and click **Submit review**.

![The review panel with held notes and a verdict](/documentation/pull-requests/review.webp "Held notes, a summary and the verdict, ready to submit.")

The review lands on GitHub as one review under your name, and the shepherd gets it as one message: your verdict, your summary and every note. When the agent answers a note, the note links to its reply. If the pull request has no shepherd yet, the same panel offers **Send the notes to** a session that worked on it.

GitHub doesn't let you approve or request changes on your own pull request; you can only comment.

### The shepherd

The **Shepherd** line names the session that owns the pull request. Agents that open a pull request through codecast usually take this on themselves. On a pull request without one, click **Assign a shepherd session** and pick a session. Switch it between **Wakes on changes** and **Paused** on the same line.

The shepherd wakes for things that need the author's hands, and stays quiet otherwise:

| What happens on the pull request | Wakes the shepherd |
|----------------------------------|--------------------|
| A check fails | Yes |
| A reviewer requests changes, or leaves a review with comments | Yes |
| Someone comments on a line | Yes |
| The branch no longer merges cleanly | Yes |
| The branch falls behind main | No, it's only noted |
| Checks go green, new commits, a review is requested | No |

Comments from bots and from the pull request's own author don't wake it. When it wakes, the agent fixes what's outstanding in one pass, pushes to the same branch, replies on GitHub to each point it addressed and resolves those threads. It doesn't merge unless a person asked it to. When the pull request merges or closes, the shepherd is released.

### On your phone

The iPhone app opens a pull request with its state, review decision, checks (failures first), reviews and the sessions that worked on it, so you can see where it stands away from your desk. The diff and line comments open on GitHub.

![A pull request on the iPhone app](/documentation/pull-requests/phone.webp "A pull request on the phone: the failing check first, then the reviews.")

## Issues as tasks

Under **Settings**, **Integrations**, the Linear and GitHub cards each have an **Issues as tasks** section. Click **Import**, pick a Linear team or project or a GitHub repository, and the codecast project its issues should go into. Each issue becomes a task with a link back to the original.

![Issues as tasks on the GitHub integration card](/documentation/pull-requests/issues.webp "One repository importing into a project, with its delegate label.")

- **It stays in step both ways.** Title, description, status, assignee and labels follow each other. A comment on the task posts on the issue, and marking the task done closes it. Priority syncs with Linear (GitHub issues have none).
- **Hand an issue to an agent from the tracker.** Set a **Delegate label** (for example *agent*) or a **Delegate assignee**, and turn on **Spawn a session on delegation**. Labeling or assigning an issue that way starts a session on it, and the issue gets a comment linking to that session.
- **Issue text is the task, never instructions.** Anyone who can open an issue can write text an agent will read, so agents do the work an issue describes but never let its text override their own rules.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| A pull request has no page in codecast | Give the codecast GitHub app access to that repository under **Settings**, **Integrations** |
| Submitting a review fails with a note about your GitHub account | Connect GitHub to your own codecast account, or review on github.com |
| The shepherd didn't react to a review | Check its line reads **Wakes on changes**, not **Paused**. Reviews from bots and from the author don't wake it |
| GitHub refuses a merge | The branch is behind, conflicted or blocked by a rule. GitHub's reason is shown; ask the shepherd to update the branch |
