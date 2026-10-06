When an agent wrote the change, the reasoning lives in a transcript, not in the pull request description. And once the PR is open, the agent that wrote it is gone: a red check, a request for changes or a merge conflict waits for a human to notice, open a new session, explain the context again and ask for a fix. Codecast closes both gaps. Every pull request page carries the sessions that made it, and one of them can be the PR's **shepherd**: the session that owns it until it merges, woken whenever GitHub has news it can act on.

![The product film's PR page for acme/billing #482 'Retry failed webhooks with exponential backoff': Open, by alex, retry-webhooks into main, label webhooks; a Shepherd row naming the session 'Retry failed webhooks', state 'ready to merge', toggle 'Wakes on changes'; linked sessions Webhook API half and Dashboard retry UI and task 'Retry queue for failed webhooks'; checks 4 passed, review Approved by sarahchen, merge Ready to merge, 0 open comments, +412/-38 across 9 files; below, the description and sarahchen's approval 'Five attempts over about thirty minutes covers the ledger restarts. Ship it.'](/blog/field-manual/prs-merged.webp "The PR page in the film: the shepherd session sits in the header with its state (&quot;ready to merge&quot;) and its wake toggle, beside the other sessions and the task the PR came from.")

## The PR page

Pull requests arrive through the codecast GitHub app. The page reads top to bottom like a status report: title, branch and labels; the **Shepherd** line; the linked sessions and tasks; then a row of figures (Checks, Review, Merge, Open comments, Diff), each one a link to the place you would go next. Below that are four tabs, Conversation, Files, Commits and Checks, on the number keys `1` to `4`. On any tab, `r` opens your review, `n` and `p` walk the open threads, and `m` marks a file viewed.

Everything you do here (review, merge, close, mark ready, request a reviewer) goes to GitHub, and the page updates from GitHub's answer. Codecast never keeps its own copy of the PR's state, so the two cannot disagree.

The PR also follows its shepherd around the app. The session's inbox card and the bar above its composer show a small chip, `#482` and one word for what the PR is waiting on, colored by whose problem it is: green when nothing blocks it, yellow or orange when it waits on a person or on CI, red when something broke. Click it to land on the PR page.

## How a PR finds its sessions

Sessions attach to a pull request three ways, none of which you have to do by hand:

- **Sessions on the branch.** When the PR opens, codecast links the sessions that worked on its head branch and proposes the most recent one as shepherd. The proposal stays paused until you turn it on.
- **A trailer on every agent commit.** Each commit an agent makes names its session, so the Commits tab shows a session pill on every commit, and from any line of code you can get back to the conversation that wrote it.
- **Task ids in the text.** A task id like `ct-4102` in the title, body or branch name links the task.

![The pull-requests feature page section 'Every pull request knows its sessions': a PR card #214 'Retry webhook deliveries with backoff' with a Shepherd session, two Linked sessions and a task; the Commits tab lists three commits each with a session pill (Webhook retry backoff, Webhook delivery audit); beside it, three numbered explanations: sessions on the branch, a trailer on every agent commit, task ids in the text](/blog/field-manual/prs-sessions.webp "Each commit wears the pill of the session that made it.")

## The shepherd

If no session owns the PR yet, the header offers **Assign a shepherd session** and lists the sessions that worked on it. Once one is bound, the Shepherd line shows the session, a phrase for where things stand ("waiting for a review", "fixing failed checks", "has merge conflicts to resolve", "ready to merge") and a switch that reads **Wakes on changes** or **Paused**. Hover it to see when it last woke and why. Agents usually set this up themselves: an agent finishing work commits in topical pieces, opens the PR with a description linking its session, and binds itself as shepherd, then goes quiet until there is news.

Not every event is news. The shepherd wakes only for something it can act on:

| Event | Effect |
|---|---|
| A check fails | wakes |
| A person requests changes, or leaves a review with a body | wakes |
| A person comments on a line | wakes |
| The branch no longer merges cleanly | wakes |
| Branch falls behind its base; checks go green; new commits; a review is requested | recorded, no wake |
| Anything from a bot, or from the PR's own author | ignored |

Each wake arrives in the session as a new turn with a briefing rebuilt from where the PR stands *now*, so it never describes a state the PR has already left. When several reasons pile up, the worst news leads (conflict, then a failed check, then changes requested). If the session is mid-turn, the wake waits for it rather than interrupting, collecting reasons as they arrive. The briefing tells the agent to fix the checks, answer the comments and push in one pass, to reply on each thread so it shows a resolution rather than going quiet, not to rebase merely because the branch is behind, and, in so many words, **not to merge unless a human asked**. A merge or close retires the shepherd.

![The pull-requests page section 'The shepherd: what wakes it, and what it reads': a list of events marked wakes, recorded or ignored, and a briefing that arrives in session jx7c6zk as a new turn: '# Shepherding acme/api PR #214', state changes_requested, 'Woken because a reviewer asked for changes', unresolved review comments on src/retry.ts:42 and :88, the review, linked work ct-4102, and a 'Your job' paragraph ending with 'Do not merge the pull request unless a human asked you to' highlighted](/blog/field-manual/prs-shepherd.webp "What the shepherd actually reads when it wakes: the reason, the unresolved threads with file and line, the review, linked tasks, and its job.")

## Held notes, sent as one review

Reviewing is a batch, not a drip. In the Files tab, a note on a line can **Post now** to GitHub or **Start a review**, which holds it. Held notes are drawn dashed and are yours alone: nobody else sees them, nothing reaches GitHub, and no session wakes. The Review button counts them (`Review · 2`), and the review bar pinned to the bottom of the page keeps the count in view while you read.

Press `r` and **Finish your review** lists every held note (click one to jump to its line), takes a summary, and asks for a verdict: Comment, Approve or Request changes. Sending makes one GitHub review under *your* GitHub account, because a verdict is a judgement and never goes out as the app. If a session owns the PR, the whole review reaches it as one message the moment GitHub accepts it, so the agent wakes once with every note in hand instead of once per comment.

![The pull-requests page section 'A review is one batch with one verdict': a Files view of src/retry.ts with two dashed 'held' notes from omar on lines 42 and 88, a bar '2 notes not sent yet. Only you can see them until you finish your review.' with Comment, Approve, Request changes and Send to session buttons; beside it the terminal sequence cast pr comment --hold, cast pr notes, cast pr review --request-changes ending 'delivered to session jx7c6zk'](/blog/field-manual/prs-batch.webp "Held notes are drawn dashed until you send. &quot;Send to session&quot; hands them to the agent as one message without a verdict and keeps them held, so the agent can act first and the same batch can still go to GitHub after.")

**Send to session** is the other way out. It gives the notes to the shepherd (or a linked session you pick) as one message, sends nothing to GitHub, and keeps the notes held. The agent fixes things first; you look again, then send the same batch to GitHub or **Discard** it. Agents review the same way from a terminal, holding notes and sending them as one review.

GitHub's own rules pass through unchanged: on your own pull request the verdict buttons are disabled, since GitHub takes a comment from you there, not a verdict. When the agent has answered a note, the note carries a link to its reply, and the agent resolves the thread once the fix is pushed.

> **Why it matters.** The shepherd is just a trigger that only a pull request event can fire, and the review is just a message to a session. Composing those two pieces gives you something no CI bot does: the agent that already holds the context for *why* the code is shaped this way is the one that answers the reviewer, fixes the check and pushes to the same branch, while the review and the merge stay with a person.
