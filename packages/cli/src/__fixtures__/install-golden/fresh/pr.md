
## Pull requests (cast pr)

A pull request is a codecast object carrying its checks, reviews, threads, and the session that owns it until it merges. `cast pr` reads and steers one from the shell. Every verb takes a number, `owner/repo#123`, a GitHub or codecast URL, or nothing (the pull request this session is bound to, else the one for your branch). Every read takes `--json`.

```bash
cast pr ls                                  # open pull requests across your teams (--repo, --mine, --shepherded, --state)
cast pr show [ref]                          # state, checks, reviews, open threads, the owning session
cast pr threads [ref]                       # open review threads, each with a short id and its file:line
cast pr events [ref]                        # timeline: pushes, reviews, checks, merges
cast pr watch [ref]                         # one line per change; the first frame is silent
cast pr open [ref]                          # the page in codecast (--print for the URL only)
```

### Reviewing a pull request

A review is a batch: hold a note on each line you have something to say about, then send them as one review with one verdict. Held notes are yours alone until you submit; nothing reaches GitHub or the author. A note names a file and line and says what should change or what you want to know; it never pastes the code.

```bash
gh pr diff 123                                              # read the change (or git diff main...<branch> in a checkout)
cast pr comment 123 --hold --file src/x.ts --line 42 "…"    # hold a note on a line (- reads the body from a heredoc)
cast pr notes 123                                           # what you are holding (--discard throws them away)
cast pr review 123 --request-changes -b "…"                 # send the batch: --approve | --request-changes | --comment
cast pr comment 123 "…"                                     # say something on the conversation now, outside a review
cast pr comment 123 --reply <thread> "…"                    # answer a thread from cast pr threads
cast pr resolve <thread> [ref]                              # settle a thread you answered (unresolve reopens it)
```

The review goes out on GitHub as the human you run as, so the verdict is theirs (GitHub refuses a verdict on their own pull request, and says so). If the pull request has an owning session, the whole review reaches it as one message the moment GitHub accepts it.

### Owning a pull request

`cast pr shepherd on [ref]` binds this session to a pull request (`--for <session>` binds another of yours); the /cast-ship skill does this when it opens one. The owner is woken when the pull request moves, and a review through codecast arrives as a message: make each change, push to the same branch, reply to the notes you addressed with `cast pr comment --reply`, and resolve the threads. Do not merge unless a human asked you to.
<!-- cast @VERSION@ -->
<!-- /codecast-pr -->

## Referencing objects

Every codecast object has a short ID. Written anywhere (messages, summaries, task comments, doc bodies, trigger prompts), it renders as a live reference: title, current state, and a link.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |

Write the bare ID by default (`Filed under ct-4102.`); it reads as a normal sentence and still renders in full. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as an unreadable blob, and every command accepts the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->
