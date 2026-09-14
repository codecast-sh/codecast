---
name: codecast-pickup
description: Rehydrate before working. Reads the bound task or plan, the pinned state, what the team did on this project recently, and the repository and tmux state, then names the work and the next three actions. Use at the start of a session, after a resume or compaction, or when asked to pick up work.
argument-hint: "[task or plan id | topic]"
---

Reground from shared state, not from memory of an earlier conversation.
Everything below was captured when this skill was invoked.

## Bound work
!`cast task context --current 2>/dev/null; cast plan context --current 2>/dev/null`

## Pinned state
!`cast state 2>/dev/null || echo "no pinned state"`

## This project, last two days
!`cast feed -s 2d -n 8 2>/dev/null`

## Repository
!`git status -sb 2>/dev/null; git log --oneline -8 2>/dev/null; git stash list 2>/dev/null`

## Live panes
!`tmux list-sessions 2>/dev/null || echo "no tmux sessions"`

## Then

Name the work in one sentence. If the argument names a task or plan, bind to
it (`cast task start <id>` or `cast plan bind <id>`). If nothing is bound,
search before creating: `cast task ls -q "<topic>"`, `cast task ready -q
"<topic>"`, `cast plan ls -q "<topic>"`; claim what exists, create only what
does not. When a handoff doc is referenced, open it with `cast doc show`.

A handoff that records test commands and their results is evidence: trust it
and do not rerun those commands. Uncommitted changes in the tree may belong to
other sessions; read `git diff` before assuming they are yours.

Finish with the next three actions in order, then start the first.
