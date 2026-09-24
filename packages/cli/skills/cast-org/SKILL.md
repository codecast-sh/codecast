---
name: cast-org
description: Talk through the organization of agents and people around this work with the person, in this session: who reports to whom, what each role looks after, where their sessions go. Reads what the code and the sessions say before it trusts a plan or a task, asks what the records cannot settle, and posts each agreed change as a small proposal that renders inline for them to accept. Use when asked who is working on what, to set up or review the org, to hire a lead or a chief of staff, or when the chart has drifted from reality.
argument-hint: "[--team <name>|personal] [what to change, in plain words]"
---

The organization is read from the top down: initiatives, the goals the
company set; the projects that carry each; the plans and tasks inside a
project; the roles that lead projects and own initiatives; the people they
report to; and the sessions that do the work. This skill is the conversation
about it, held where the person already is. The org page holds the same
conversation beside the chart. A change is accepted on a card here or on that
page, and nothing moves until they accept it.

## Look first

Every org verb reads the active workspace unless `--team` names another;
`--team personal` is the person's own. Say which workspace you are looking
at in your first line: the wrong company is the commonest wrong answer
here, and a list of roles does not reveal it.

```bash
cast org ls                      # people, roles with their scopes, the sessions under each
cast org proposals               # anything already waiting on a person
cast org health                  # load, flags, stale records, span
cast initiative ls               # the goals: status, owner, health, target
cast org inputs                  # ends with coverage: projects with a lead, work outside any project
```

Then:

```bash
cast org init --here             # no roles yet: the briefing, in this session
cast org review --here           # roles exist: the same briefing in review mode
```

Follow the briefing it prints. It carries what to read, the grounding rules,
the initiative and coverage rules, the capacity model, the standing versus
program rule, the honesty rules, the spec, and how the conversation is held;
do not restate or replace them.

When one person works in one area with nothing filed, there is nothing to
organize: say so, say what would make a chart worth having, and stop.

## The conversation

Read everything first, then talk. Lead with the reporting structure: who
reports to whom, what each role looks after, and where the person's own
sessions go, as it stands and as you would change it. Short messages in
plain words, one thing at a time. Ask what the records cannot settle, take
the answer, and move on. Hold the evidence and give it when asked; no ids in
prose, nothing about yourself.

When something is agreed, or the records settle it on their own, post it as
a small proposal and put its short id on its own line, where it renders as a
card with Accept, Skip and Ask:

```bash
cast org propose --spec proposal.json [--supersedes op-N]
```

Many small proposals over the conversation, never one document. An edit the
person gives in plain words folds into the next proposal, or into one you
posted, in place:

```bash
cast org revise op-N --remove 3 --note "growth is not dead yet"
cast org revise op-N --amend 1 --edits '{"scope":{"add":["pr-12"]}}' --rationale "why"
cast org revise op-N --add change.json          # one spec change, or a list
```

A change they already decided is refused by name. A proposal somebody else
posted is theirs: an edit on it lands on the page by change number, and a
withdraw is theirs, on the page or with `cast org proposals --withdraw op-N`
at their own shell.

Proposals already open outrank a new one on the same subject. Read them
back in a few plain lines, compare with what health says now, and name a
difference only where it would move a change. Do not post their changes
again and do not withdraw them.

## End

A change no proposal carries, a role retired, created or moved by hand, is
made on the org page and nowhere else; a shell is refused, so point them at
the page, not at a command. The hire and every accept are theirs: no session
decides a staffing change. A chief of staff, once hired (`cast org staff`, or
the button on the page), holds this conversation weekly without them.
