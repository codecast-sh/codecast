When an agent wrote the change, the reasoning lives in a transcript, not in the pull request description. And once the PR is open, the agent that wrote it is gone: a red check, a request for changes or a merge conflict waits for a human to notice, open a new session, explain the context again and ask for a fix. Codecast closes both gaps. Every pull request carries links to the sessions that made it, and one session can be bound to the PR as its **shepherd**, woken by GitHub events until the merge.

![The product film's PR page for acme/billing #482 'Retry failed webhooks with exponential backoff': Open, by alex, retry-webhooks into main, label webhooks; a Shepherd row naming the session 'Retry failed webhooks', state 'ready to merge', toggle 'Wakes on changes'; linked sessions Webhook API half and Dashboard retry UI and task 'Retry queue for failed webhooks'; checks 4 passed, review Approved by sarahchen, merge Ready to merge, 0 open comments, +412/-38 across 9 files; below, the description and sarahchen's approval 'Five attempts over about thirty minutes covers the ledger restarts. Ship it.'](/blog/field-manual/prs-merged.webp "The PR page in the film: the shepherd session sits in the header with its state (&quot;ready to merge&quot;) and its wake toggle, beside the other sessions and the task the PR came from.")

## How a PR finds its sessions

Pull requests arrive through the codecast GitHub app, and a webhook is the only writer of the PR row: nothing you do in codecast writes it directly; every act goes to GitHub, and GitHub's webhook updates the row, so the two sides cannot disagree. Sessions are linked three ways:

- **Sessions on the branch.** When GitHub reports the PR opened, codecast links the sessions that worked on its head branch and picks the most recent one in that repository as the shepherd candidate. The candidate stays paused until you turn it on.
- **A trailer on every agent commit.** The `Codecast-Session:` trailer (see team memory above) names each commit's session outright, and the Commits tab renders it as a session pill.
- **Task ids in the text.** A task id like `ct-4102` in the title, body or branch name links the task, and the shepherd's briefing lists it under linked work.

From the other side, `cast search "pr:acme/api#214"` returns every session behind a pull request, and `cast blame` attributes each line.

![The pull-requests feature page section 'Every pull request knows its sessions': a PR card #214 'Retry webhook deliveries with backoff' with a Shepherd session, two Linked sessions and a task; the Commits tab lists three commits each with a session pill (Webhook retry backoff, Webhook delivery audit); beside it, three numbered explanations: sessions on the branch, a trailer on every agent commit, task ids in the text](/blog/field-manual/prs-sessions.webp "From `/features/pull-requests`: each commit wears the pill of the session that made it.")

## The shepherd

`cast pr shepherd on` binds the current session to a pull request (by number, `owner/repo#n`, URL, or nothing for the PR on your branch) and creates one standing trigger for it. Only a wake sets that trigger to run, and a wake comes from something the agent can act on:

| Event | Effect |
|---|---|
| A check fails | wakes |
| A person requests changes, or leaves a review with a body | wakes |
| A person comments on a line | wakes |
| The branch no longer merges cleanly | wakes |
| Branch falls behind its base; checks go green; new commits; a review is requested | recorded, no wake |
| Anything from a bot, or from the PR's own author | ignored |

Each wake hands the session a briefing rebuilt from where the pull request stands *now*, so it never describes a state the PR has already left. When several reasons pile up, the worst news leads (conflict, then a failed check, then changes requested). If the shepherd is mid-run, the wake does not interrupt it: it retries every 20 seconds, up to 5 times, collecting reasons as they arrive. The briefing tells the agent to fix the checks, answer the comments and push in one pass, to reply on each thread so it shows a resolution rather than going quiet, not to rebase merely because the branch is behind, and, in so many words, **not to merge unless a human asked**. A merge or close retires the trigger.

![The pull-requests page section 'The shepherd: what wakes it, and what it reads': a list of events marked wakes, recorded or ignored, and a briefing that arrives in session jx7c6zk as a new turn: '# Shepherding acme/api PR #214', state changes_requested, 'Woken because a reviewer asked for changes', unresolved review comments on src/retry.ts:42 and :88, the review, linked work ct-4102, and a 'Your job' paragraph ending with 'Do not merge the pull request unless a human asked you to' highlighted](/blog/field-manual/prs-shepherd.webp "What the shepherd actually reads when it wakes: the reason, the unresolved threads with file and line, the review, linked tasks, and its job.")

```terminal
$ cast pr shepherd on
$ cast pr shepherd status
$ cast pr watch 482          # one line per change: shepherd state, checks, review, merge state
$ cast pr show 482           # checks, reviews, open threads, linked sessions, last events
$ cast pr shepherd off       # release it
```

The `/cast-ship` skill does the whole run from finished work: it commits in topical pieces, opens the PR with a description that links the session, and binds the session as shepherd, so the agent sleeps between events instead of polling. `/cast-ship feedback` skips straight to working the open threads once.

## Held notes, sent as one review

Reviewing is a batch, not a drip. You hold a note on each line that needs one, from the Files view or the CLI, and held notes are yours alone: nobody else sees them, nothing reaches GitHub, and no session wakes. When you finish, they leave together as one GitHub review with one verdict, under *your* GitHub account (a verdict is a judgement, so it never goes out as the app). If a session owns the PR, the whole review reaches it as one message the moment GitHub accepts it, so the agent wakes once with every note in hand instead of once per comment.

```terminal
$ cast pr comment 214 --hold --file src/retry.ts --line 42 "Jitter can push the delay past the cap."
ok held for your review of acme/api#214 (`cast pr notes` lists it, `cast pr review` sends the batch)

$ cast pr notes 214
acme/api#214  2 held notes
  q4c7b2xm  src/retry.ts:42  Jitter can push the delay past the cap.
  r81kd0ve  src/retry.ts:88  Log the attempt number so a stuck delivery is findable.

$ cast pr review 214 --request-changes -b "Two notes, then good to go."
ok requested changes on acme/api#214 with 2 notes as omar
  https://github.com/acme/api/pull/214#pullrequestreview-2841907733
  delivered to session jx7c6zk
```

![The pull-requests page section 'A review is one batch with one verdict': a Files view of src/retry.ts with two dashed 'held' notes from omar on lines 42 and 88, a bar '2 notes not sent yet. Only you can see them until you finish your review.' with Comment, Approve, Request changes and Send to session buttons; beside it the terminal sequence cast pr comment --hold, cast pr notes, cast pr review --request-changes ending 'delivered to session jx7c6zk'](/blog/field-manual/prs-batch.webp "Held notes are drawn dashed until you send. &quot;Send to session&quot; hands them to the agent as one message without a verdict and keeps them held, so the agent can act first and the same batch can still go to GitHub after.")

Some rules come straight from GitHub and are passed through verbatim: you cannot approve your own pull request, and `--request-changes` or `--comment` needs a body. Review text reaches the agent fenced, each note and the summary capped at 3,000 characters inside a delimiter naming its source. After fixing, the agent answers each thread with `cast pr comment --reply <thread>` and settles it with `cast pr resolve <thread>`, naming threads by the short id `cast pr threads` prints or by `file:line`.

> **Why it matters.** The shepherd is just a trigger that only a pull request event can fire, and the review is just a message to a session. Composing those two existing pieces gives you something no CI bot does: the agent that already holds the context for *why* the code is shaped this way is the one that answers the reviewer, fixes the check and pushes to the same branch, while the review and the merge stay with a person.
