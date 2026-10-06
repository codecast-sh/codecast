
## Pull requests (cast pr)

`cast pr` reads and steers a pull request from the shell: its checks, reviews, threads, and the session that owns it until it merges. Every verb takes a number, `owner/repo#123`, a URL, or nothing (the pull request this session is bound to, else the one for your branch).

**Review as a batch.** Hold a note on each line you have something to say about, then send them as one review with one verdict; nothing reaches GitHub or the author until you submit. A note names a file and line and says what should change or what you want to know; it never pastes the code. Use this rather than `gh pr review` or posting comments one at a time.

```bash
cast pr show [ref]                                        # state, checks, reviews, open threads, owner
gh pr diff 123                                            # read the change
cast pr comment 123 --hold --file src/x.ts --line 42 "…"  # hold a note on a line
cast pr review 123 --request-changes -b "…"               # send the batch: --approve | --request-changes | --comment
cast pr threads [ref]; cast pr comment 123 --reply <thread> "…"; cast pr resolve <thread>
```

The review goes out on GitHub as the human you run as, so the verdict is theirs. **Owning a pull request:** `cast pr shepherd on [ref]` binds this session to it, and you are woken when it moves: make each change, push to the same branch, reply to the notes you addressed, and resolve their threads. Do not merge unless a human asked you to. `cast guide pr` has the rest.
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
| Call    | `cl-42`   | `cast calls` |

Write the bare ID by default (`Filed under ct-4102.`); it reads as a normal sentence and still renders in full. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as an unreadable blob, and every command accepts the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->
