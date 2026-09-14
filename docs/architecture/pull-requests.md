# Pull requests in sync with GitHub

A pull request lives on GitHub. Codecast holds a copy of it, keeps the copy
current from GitHub's webhooks, and sends every action a person takes here back
to GitHub. The page, the CLI and an agent all act through one server layer, so
nothing one of them can do is missing from another.

## S1. The row

`pull_requests` is one row per pull request per team. `team_id` is routing,
never access: a member of the team reads it, nobody else does. The row carries
what GitHub knows (state, draft, head and base, files, commits, checks, labels,
assignees, requested reviewers, mergeability) and what codecast adds (the
shepherd session, linked sessions, tasks the pull request closes).

Comments on the pull request are `review_comments` rows: a line comment, a
conversation comment, or a reply (`parent_id`). A row written on GitHub has
`author_kind: "github"` and the GitHub ids; a row written here has
`codecast_origin: true` and gains the GitHub ids when it is mirrored.

Reviews are `reviews` rows: one per GitHub review, with the verdict, the summary,
and `github_review_id`. A line comment submitted inside a review carries the
same `github_review_id`, which is how the timeline nests it under the review.

## S2. Inbound: GitHub to codecast

Every delivery lands in `github_webhook_events` and is processed by the handler
for its kind (`githubWebhooks.ts`): opened, synchronized, closed, reopened,
edited, draft, ready, review requested, labeled, assigned; reviews (submitted,
dismissed); review comments (created, edited, deleted); review threads
(resolved, unresolved); issue comments on the pull request; check runs, check
suites, workflow runs and commit statuses; pushes.

Two rules keep the inbound side honest:

- A comment codecast posted comes back as a webhook. It is recognised by its
  GitHub id, recorded at mirror time, and skipped. A note submitted inside a
  review may echo back before its id is recorded; the same words on the same
  line of the same pull request from an unmirrored codecast row is that note, and
  the row is adopted rather than inserted twice.
- A dismissed review stays in the history as `dismissed` and counts for nothing
  in the review decision. The decision is the newest verdict of each reviewer;
  one request for changes outranks any number of approvals.

A team install that lands, or gains repositories, backfills the pull requests
already there (`githubApp.backfillInstallationPulls`) through the quiet upsert
`pull_requests.syncPRFromGitHub`, which replays no "opened" moments. A page
opened on a pull request the backfill did not reach asks GitHub for it once
(`githubApp.fetchPull`).

## S3. Outbound: codecast to GitHub

Every change made here reaches GitHub, through the App's installation token
unless the act needs a person's name on it:

| Act | Path | Token |
| --- | --- | --- |
| Comment on a line or the conversation | `codeComments.create` then `mirrorToGitHub` | App |
| Reply | same, posted under the parent's GitHub id; waits while the parent is still in flight | App |
| Edit, delete | `mirrorEditToGitHub`, `mirrorDeleteToGitHub` | App |
| Resolve, unresolve a thread | `mirrorThreadResolution` through GitHub's GraphQL review thread mutation | the person's, then the App's |
| Review with a verdict | `reviews.submitReviewWithNotes`: one GitHub review carrying every pending note | the person's only |
| Merge, close, reopen, draft, ready, reviewers, title, body | `prCli.*` verbs | the person's, then the App's |

A GitHub installation token cannot resolve a review thread ("Resource not
accessible by integration"), so resolution prefers the resolver's own token.

Nothing on the outbound side writes the pull request row. GitHub answers every
act with a webhook, and the inbound handler is the one writer. That is what
keeps the two sides from disagreeing.

## S4. The review is a batch

A note written with the review switch on is a `review_comments` row with
`pending_review: true`. It is the author's alone: every read path hides other
people's pending notes, nothing announces it, nothing mirrors it. The notes
leave together, one of two ways:

- **To GitHub**, as one review with a verdict and a summary
  (`reviews.submitPending` from the page, `cast pr review` from the terminal).
  GitHub's comment ids come back and stamp the rows.
- **To a session**, as one message built by the same prompt builder `cast
  review send` uses (`reviews.handPendingToSession`). The notes stay pending, so
  the same batch can still go to GitHub after the agent has acted.

`cast pr comment --hold` adds a note from the terminal, `cast pr notes` lists
them, `cast pr review` sends them.

## S5. One action layer

`prCli.ts` is the server behind `cast pr` and behind the pull request page.
Every verb resolves the caller from a CLI token or a signed in session, resolves
the pull request from whatever the caller named (a number, `owner/repo#n`, a
URL, a session, a branch), picks a token, makes one GitHub call, and answers
with GitHub's own words when GitHub refuses. The page calls these verbs by
name; the CLI reaches them through `/cli/pr/*` routes in `http.ts`.

## S6. The page

`/pr/:owner/:repo/:number` reads the store (`pullRequests`, `codeComments`)
and never a query. The header names the state, the merge standing, the review
decision, the labels and the assignees, and carries the verbs: the review menu
(what is waiting, the verdict, submit or send to the session), merge with its
method and branch deletion, and the rest behind one more button.

Files carry the review: a switch above a fresh line's composer chooses between
holding the note and posting it now; a held note is drawn dashed; the tree
counts open threads and held notes per file and dims files marked viewed. `n`
and `p` walk the open threads, `m` marks the file viewed and moves on, `r`
opens the review menu. Commits is its own tab. The conversation nests each
review's line notes under it, and hides the empty "commented" reviews GitHub
wraps a lone reply in.
