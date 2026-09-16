# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

## Referencing objects

Every codecast object has a short ID. Write one into your prose and it renders as a live reference: the object's title, its current state, and a link that opens it. This works anywhere you write — messages, summaries, task comments, doc bodies, trigger prompts.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |

There are two forms. Write the bare ID by default — `Filed under ct-4102.` — it reads as a normal sentence and still renders the full reference. Write `@[Title id]` — `@[Fix the auth race ct-4102]` — when the reader needs the name in the sentence itself.

Never paste an object's 32-character internal ID into prose. It renders as an unreadable blob, and every command that accepts an ID accepts the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Pull requests (cast pr)

A pull request is a codecast object like a session or a task: it carries its checks, the reviews and threads on it, and the session that owns it until it merges. `cast pr` reads and steers one from the shell, so you can review a teammate's or another agent's change, and answer a review of your own, without a browser. Every verb takes the same reference: a number, `owner/repo#123`, a GitHub or codecast URL, or nothing, which means the pull request this session is bound to, else the one for the branch you stand on. Every read takes `--json`.

```bash
cast pr ls                                  # open pull requests across your teams (--repo, --mine, --shepherded, --state)
cast pr show [ref]                          # state, checks, reviews, open threads, the owning session
cast pr threads [ref]                       # the open review threads, each with a short id and its file:line
cast pr events [ref]                        # the timeline: pushes, reviews, checks, merges
cast pr watch [ref]                         # one line per change; the first frame is silent
cast pr open [ref]                          # the page in codecast (--print for the URL only)
```

### Reviewing a pull request

A review is a batch. Read the change, hold a note on each line you have something to say about, then send the batch as one review with one verdict. Held notes are yours alone until you submit: nobody else sees them, and nothing reaches GitHub or the author. A note names a file and a line, and says what should change or what you want to know; it never pastes the code, because the author reads the file.

```bash
gh pr diff 123                                              # read the change (or git diff main...<branch> in a checkout)
cast pr comment 123 --hold --file src/x.ts --line 42 "…"    # hold a note on a line for your review
cast pr comment 123 --hold --file src/x.ts --line 42 -      # …the body from a heredoc
cast pr notes 123                                           # what you are holding (--discard throws them away)
cast pr review 123 --request-changes -b "…"                 # send the batch as one review: --approve | --request-changes | --comment
cast pr comment 123 "…"                                     # say something on the conversation now, outside a review
cast pr comment 123 --reply <thread> "…"                    # answer a thread from cast pr threads
cast pr resolve <thread> [ref]                              # settle a thread you have answered (unresolve reopens it)
```

The review goes out on GitHub under the account of the human you run as, so the verdict is theirs: GitHub refuses a verdict on their own pull request, and says so in its own words. When the pull request has an owning session, the whole review, verdict, summary and every note, reaches that session as one message the moment GitHub accepts it, so the author acts on it at once.

### Owning a pull request

`cast pr shepherd on [ref]` binds this session to a pull request (`--for <session>` binds another of yours); the /cast-ship skill does this when it opens one. The owner is woken when the pull request moves, and a review submitted through codecast arrives as a message: make each change it asks for, push to the same branch, reply on GitHub to the notes you addressed with `cast pr comment --reply`, and resolve the threads, so the review shows the resolution rather than going quiet. Do not merge unless a human asked you to.
<!-- cast @VERSION@ -->
<!-- /codecast-pr -->
