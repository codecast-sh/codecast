
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

Every codecast object has a short ID. Written anywhere (a message, comment, doc or prompt), it renders as a live reference: title, state and a link.

- Session `jx7c6zk`: `cast feed`, `cast search`, `cast context`
- Task `ct-4102`: `cast task ls`, `cast task ready`
- Plan `pl-88`: `cast plan ls`
- Trigger `tr-42`: `cast trigger ls`
- Doc `doc:<id>`: `cast doc ls`, `cast doc search`
- Call `cl-42`: `cast calls`
- Flow `flow:change`: `cast flow ls`
- Deploy `dp-1972`: `cast line deploy targets`
- Issue `eg-2242`: `cast events groups`
- Metric `mw-12`: `cast metrics ls`
- Replay `rp-311@1:23`: `cast replay ls`

Write the bare ID by default (`Filed under ct-4102.`); it reads as a sentence and renders in full. An ID alone on its line is a live card: a metric's chart, an issue's last 72h, a flow's steps. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as a blob, and every command takes the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->
