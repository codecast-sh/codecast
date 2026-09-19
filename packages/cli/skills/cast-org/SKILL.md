---
name: cast-org
description: Look at the organization of agents and people around this work, then set it up or bring it up to date with the person, in this session. Reads what the code and the sessions say before it trusts a plan or a task, proposes roles, scopes and record fixes with the evidence beside each, takes the person's edits in plain words, and posts the result for them to accept. Use when asked who is working on what, to set up or review the org, to hire a lead or a chief of staff, or when the chart has drifted from reality.
argument-hint: "[--team <name>|personal] [what to change, in plain words]"
---

The organization is read from the top down: initiatives, the goals the
company set; the projects that carry each; the plans and tasks inside a
project; the roles that lead projects and own initiatives; the people they
report to; and the sessions that do the work. This skill is that conversation, held wherever the person
already is. The org page does the same work with a chart and a guided
setup, and it stays the only place a change is accepted; say so once, then
carry on here.

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

Then open in one of three ways.

**A proposal is open.** It outranks a new one. `cast org apply op-N` prints
its changes with each one's status and applies nothing; `--json` carries
every change's rationale and evidence. Read it back in the thread: the
records it brings in line as counts, each role in one line with its
evidence, what is already decided, and the link. Compare what it claims
with what health says now, and name a difference only where it would move
a change; counts that drifted by a few since the post are not news. Do not
post beside it and do not withdraw it.

When the open proposal is your own (this session posted it, or you are the
standing session of the role that did), an edit the person gives you is
yours to make, in place, before they decide:

```bash
cast org revise op-N --remove 3 --note "growth is not dead yet"
cast org revise op-N --amend 1 --edits '{"caps":{"wakes_per_day":6}}' --rationale "half the wakes"
cast org revise op-N --add change.json          # one spec change, or a list
```

Removing, amending and adding touch only changes nobody has decided; a
decided one is refused by name, and accepting stays theirs on the page.
`--note` is one line in your words that the page shows beside each change
the revise touched, so say why. Their message from the page opens with the
change they were looking at ("About op-N change 3"); answer about that row.

When the open proposal is someone else's, an edit the person gives you
lands on the page, not in a new post: name the change it edits or skips by
its number, and the order when an accept depends on a skip. An edit the
proposal cannot carry waits for the withdraw, which is theirs, on the page
or with `cast org proposals --withdraw op-N` at their own shell; run the
review after it.

**No roles yet.** Say what the workspace holds: who is in it, where the
sessions and commits are, what is filed. When that is one person in one
area with nothing filed, there is nothing to organize: say so, say what
would make a chart worth having, and stop. Otherwise run init.

**A chart exists.** Read it back in a few lines: each initiative and how it
is going, each role, what it owns, what health flags on it, the projects
with no lead, and the records the activity says are behind.
Then run review.

## The default is coverage

Unless the person asks for something narrower, the aim is that every piece
of work has a lead. Every active initiative has an owner, and one without
is the first thing you say. Every project with work planned or in progress
has a lead, and a project without one gets a role that wraps the project as
it is filed, under its own name. Work that sits outside any project
(sessions, commits, plans with none) gets a project first, then a lead.
About one role per project; when two small projects share a lead or a large
one is split, say why. Say where coverage stands before and after, in
counts. Full coverage costs a daily limit per role, so say the cost with it
and let the person trim.

## Ground, then propose

```bash
cast org init --here             # no roles: the analyzer prompt, in this session
cast org review --here           # roles exist: the same prompt in review mode
```

Follow the prompt it prints. It carries the initiative and coverage rules,
the capacity model, the grounding rules, the standing versus program rule,
the honesty rules and the spec it wants; do not restate or replace them. One thing differs because the person
is here: where the prompt ends with a post, this skill shows the shape
first and posts when the person says it is right.

## Show the shape, then take the edits

A list of roles is not judgeable; the evidence beside each role is. Put the
proposal in the thread before any file exists:

- how each active initiative is doing, one line each, and any with no
  owner;
- the records to bring in line, as counts per kind with a few named, and
  what closing them takes out of the loads;
- each role in one line: handle, standing or program and what ends it, the
  projects it owns, who it reports to, and the numbers that justify it
  (sessions, commits, open work in its scope, its load against the model);
- coverage before and after in counts, with any project left without a
  lead and the reason;
- the filings and charters in one line, and the company budget today next
  to after;
- what you could not verify.

A role whose line carries no numbers is a role to drop before the person
sees it; in a readback of a proposal you did not write, say that it has
none. Then ask what is wrong.

Take the answer in plain words and fold it into the spec: a plan they call
dead is a status change, an area they say belongs to someone is that role's
scope and owner, two roles they call one is a merge with the load summed
again. When the words fit two different changes, ask which. Show back only
the lines that changed, in the same form, with the numbers that moved.
Repeat until they say the shape is right, and do not post before that.

```bash
cast org propose --spec proposal.json [--supersedes op-N]
```

Post once. `--supersedes` names an open proposal this session or the person
posted earlier; naming another author's is refused. After the post, a change
of mind is a revise (`cast org revise op-N`, above), not a second post.

## End

Say where it landed and what is now theirs: the proposal id and its link;
what it would change in one line; that each change is accepted, edited or
skipped on the org page and nothing moves until they do; when you
superseded one, that the older is theirs to withdraw; and that a chief of
staff, once hired (`cast org staff`, or the button on the page), runs this
review weekly without them. A change no proposal carries, a role retired,
created or moved under someone else, is made on the org page and nowhere
else; a shell is refused, so point them at the page, not at a command. The
hire and every accept are theirs: no session decides a staffing change.
