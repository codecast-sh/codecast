Agents that change TypeScript check their work by typechecking it, and a typecheck of a real project is heavy: it loads the whole program into memory, often a gigabyte or two, and takes minutes on a busy machine. When every session runs its own, ten agents build the same program ten times at once. The machine runs out of memory, everything slows to a crawl, and the checks take longer still.

With Typecheck on, agents on the same computer share one typecheck for each project. It stays loaded between checks and only rechecks the files that changed, so an agent's check comes back in seconds, and ten agents asking cost the same as one.

```figure
SharedProgramFigure
Left: every session builds the same program again, and memory runs out. Right: every session asks one shared typecheck that already holds it.
```

## Turn it on

1. Open **Agent features** from your account menu and pick the computer your agents run on.
2. Switch on **Typecheck**, under *Hands on the machine*.
3. New sessions on that computer use the shared typecheck from then on.

There's nothing else to set up for a project with one TypeScript configuration. Agents check the project they're working in.

## What you see

Nothing new to learn. Ask for a typecheck the way you would anyway ("typecheck the web app and fix what's red"), or just ask for a change: agents check their own TypeScript before calling the work done. The agent reports what it found, project by project, and fixes what's red.

![A conversation where the agent typechecked a small project, found three errors in one file and fixed them](/documentation/typecheck/conversation.webp "Asked to typecheck a small project and fix what is red. The agent found three errors, fixed them where they were, and said the check passes.")

- **The first check is the slow one.** It builds the program, so it takes as long as an ordinary typecheck. Every check after that, from any session in the same checkout, takes seconds.
- **Your machine stays usable.** With a dozen agents at work, memory holds one program per project instead of one per agent.
- **It tidies up after itself.** A shared typecheck nobody has asked in 45 minutes closes on its own. A machine keeps at most six running; when a seventh is needed, the one asked least recently makes room, and if all six are busy the new check waits its turn.

## Repositories with several projects

A repository with more than one TypeScript program (a web app, a server and a command line tool, say) can list them by name in a small file in the repo, `.codecast/check.toml`. Agents can then check one by name ("typecheck the server") or all of them at once. Without the list, an agent checks the configuration closest to the folder it's working in, which may not be the program its change reaches.

You don't need to write the file yourself. Ask an agent: "set up codecast typecheck for every TypeScript project in this repo". Point each entry at the configuration the project's own typecheck script uses, and keep the file in git so every copy of the repo has it.

## Worktrees

Each separate copy of a repository (a worktree) gets its own shared typecheck, because its files differ. The first check in a new worktree starts from what the main checkout already knows and rechecks only what the worktree changed, so it's quicker than a cold start. Each one still holds a whole program in memory, so give separate worktrees only to agents whose edits would collide.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The first check takes minutes | Expected: it is building the program. Later checks take seconds |
| The agent says a check is still running on a loaded machine | Let it finish and ask again. Starting another typecheck adds to the load that made it slow |
| Hundreds of errors nobody wrote | The project list likely points at the wrong configuration. Ask the agent to compare it with the project's own typecheck script |
| Errors look stale after installing packages | Ask the agent to restart the typecheck for that project |
| Agents still run their own typecheck | Check Typecheck is on for that computer, and start a new session |
