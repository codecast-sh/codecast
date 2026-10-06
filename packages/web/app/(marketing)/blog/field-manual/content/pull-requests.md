When an agent wrote the change, the reasoning lives in a transcript, not the PR description. And once the PR is open, the agent is gone: a red check or a request for changes waits for a human to open a new session, explain the context again and ask for a fix. In codecast every pull request page carries the sessions that made it, and one of them can be the PR's **shepherd**: the session that owns it until it merges, woken whenever GitHub has news it can act on.

![The product film's PR page for acme/billing #482 'Retry failed webhooks with exponential backoff': Open, by alex, retry-webhooks into main, label webhooks; a Shepherd row naming the session 'Retry failed webhooks', state 'ready to merge', toggle 'Wakes on changes'; linked sessions Webhook API half and Dashboard retry UI and task 'Retry queue for failed webhooks'; checks 4 passed, review Approved by sarahchen, merge Ready to merge, 0 open comments, +412/-38 across 9 files; below, the description and sarahchen's approval 'Five attempts over about thirty minutes covers the ledger restarts. Ship it.'](/blog/field-manual/prs-merged.webp "The PR page in the film: the shepherd session sits in the header with its state (&quot;ready to merge&quot;) and its wake toggle, beside the other sessions and the task the PR came from.")

## The PR page

The page reads like a status report: title and branch, the **Shepherd** line, linked sessions and tasks, then Checks, Review, Merge, Open comments and Diff, each a link to where you would go next. Four tabs (Conversation, Files, Commits, Checks) sit on the keys `1` to `4`; `r` opens your review, `n` and `p` walk open threads. Whatever you do here (review, merge, close, request a reviewer) goes to GitHub, and the page updates from GitHub's answer, so the two never disagree.

The PR also follows its shepherd: the session's inbox card and the bar above its composer show a chip, `#482` and one word for what it waits on, green when nothing blocks it, yellow or orange when it waits on a person or CI, red when something broke.

## How a PR finds its sessions

Sessions attach on their own, three ways:

- **Sessions on the branch.** Everything that worked on the head branch is linked, and the most recent is proposed as shepherd, paused until you turn it on.
- **A trailer on every agent commit.** Each agent commit names its session, so the Commits tab shows a session pill on every commit.
- **Task ids in the text.** A task id like `ct-4102` in the title, body or branch links the task.

![The pull-requests feature page section 'Every pull request knows its sessions': a PR card #214 'Retry webhook deliveries with backoff' with a Shepherd session, two Linked sessions and a task; the Commits tab lists three commits each with a session pill (Webhook retry backoff, Webhook delivery audit); beside it, three numbered explanations: sessions on the branch, a trailer on every agent commit, task ids in the text](/blog/field-manual/prs-sessions.webp "Each commit wears the pill of the session that made it.")

## The shepherd

With no shepherd yet, the header offers **Assign a shepherd session**. Once bound, the line shows the session, where things stand ("fixing failed checks", "ready to merge") and a switch reading **Wakes on changes** or **Paused**; hover for when it last woke and why. Usually the agent sets this up itself: it opens the PR with a description linking its session, binds itself, and goes quiet until there is news it can act on:

| Event | Effect |
|---|---|
| A check fails | wakes |
| A person requests changes, or leaves a review with a body | wakes |
| A person comments on a line | wakes |
| The branch no longer merges cleanly | wakes |
| Branch falls behind its base; checks go green; new commits; a review is requested | recorded, no wake |
| Anything from a bot, or from the PR's own author | ignored |

Each wake is a new turn in the session, with a briefing rebuilt from where the PR stands *now*, worst news first. A busy session is not interrupted; reasons collect until it is free. The briefing says to fix, answer and push in one pass, reply on every thread, not rebase just because the branch is behind, and **not to merge unless a human asked**. A merge or close retires the shepherd.

![The pull-requests page section 'The shepherd: what wakes it, and what it reads': a list of events marked wakes, recorded or ignored, and a briefing that arrives in session jx7c6zk as a new turn: '# Shepherding acme/api PR #214', state changes_requested, 'Woken because a reviewer asked for changes', unresolved review comments on src/retry.ts:42 and :88, the review, linked work ct-4102, and a 'Your job' paragraph ending with 'Do not merge the pull request unless a human asked you to' highlighted](/blog/field-manual/prs-shepherd.webp "What the shepherd actually reads when it wakes: the reason, the unresolved threads with file and line, the review, linked tasks, and its job.")

## Held notes, sent as one review

In the Files tab a note on a line can **Post now** or **Start a review**, which holds it. Held notes are dashed and yours alone: nothing reaches GitHub and no session wakes. The Review button counts them (`Review · 2`). Press `r` and **Finish your review** lists them, takes a summary and a verdict (Comment, Approve, Request changes), and sends one GitHub review under *your* account, since a verdict never goes out as the app. The shepherd gets the whole review as one message, so it wakes once with every note in hand.

![The pull-requests page section 'A review is one batch with one verdict': a Files view of src/retry.ts with two dashed 'held' notes from omar on lines 42 and 88, a bar '2 notes not sent yet. Only you can see them until you finish your review.' with Comment, Approve, Request changes and Send to session buttons; beside it the terminal sequence cast pr comment --hold, cast pr notes, cast pr review --request-changes ending 'delivered to session jx7c6zk'](/blog/field-manual/prs-batch.webp "Held notes are drawn dashed until you send. &quot;Send to session&quot; hands them to the agent as one message without a verdict and keeps them held, so the agent can act first and the same batch can still go to GitHub after.")

**Send to session** is the other way out: the notes go to the shepherd (or a linked session you pick), nothing goes to GitHub, and the notes stay held, so the agent can fix first and you send or **Discard** the batch after. On your own PR the verdicts are disabled, as GitHub takes only a comment from you. An answered note links to the agent's reply.

> **Why it matters.** The shepherd is just a trigger that only a pull request event can fire, and the review is just a message to a session. Together they give you what no CI bot does: the agent that knows *why* the code is shaped this way answers the reviewer, fixes the check and pushes to the same branch, while the review and the merge stay with a person.
