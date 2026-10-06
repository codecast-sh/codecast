# How agents communicate through the org

What the org tells an agent about whom to talk to, why, and how we keep checking that it works. The founding study (2026-10-06) is published at https://codecast.sh/a/ViJvTmGJxJwO; its raw data lives in `$CODECAST_EVALS_HOME/org-comms/study-2026-10-06`, never in git.

## AC1. The policy

The org does two jobs for communication, and neither is routing every message.

- **Direction comes down the line.** Only a session's lead (the session that spawned it, else its role) or its person changes what it works on. A request from anyone else is information, which the session takes to its lead. The exception is a hold or stop on something another session owns (a release, a deploy, a branch, a claimed file): that is honored at once.
- **Leads synthesize by reading.** Inside an area, sessions write progress, findings and blockers where their lead reads them (the task, the pinned state). The lead reads the whole area each time it runs and sends each session only what changes its next step. Anything that involves a session outside the area goes straight to that session or its area's owner. A conflict with another area starts with that owner and goes up only when the two cannot settle it.

The wording is `ORG_CONTEXT_GUIDANCE` (`packages/shared/contracts/orgWhere.ts`), injected at session start inside `<org-context>` and printed by `cast org where`. A lead's routine (`ROLE_CHECK_PROMPT`, `convex/lib/orgRoutine.ts`) carries the synthesis duty on every run; `armRoleRoutines` brings hired roles up to a changed prompt.

## AC2. Why this policy

- **Real traffic** (6,525 messages, Sept 6 to Oct 6, 320 read in full). Agent-to-agent noise was 7%, and half of all messages changed what the recipient did. Most direction came from outside the spawn line, and most of that was legitimate resource coordination. Informal hubs (release and merge drivers) took half of all messages.
- **Ablation** (about 2,500 graded runs, 20 situations, three models). Today's wording, variant G3 in the suite, was perfect on Opus and Fable. It beat the previous route-to-owner text, which let out-of-line redirects through without the lead hearing (p = 0.006 on Opus).
- **Simulation** (64 worlds, up to ten workers). With a lead that reads its whole area, G3 sent 36% fewer messages than free peer messaging (p = 0.0004) and delivered as many facts on time, at about a third of a round of extra latency. A lead choosing its own reads dropped a quarter of the facts, which is why the routine reads the whole brief.

## AC3. Huddle delivery

Live huddle transcripts reach fed sessions through `transcripts.deliverRoutes`. In the study they were about 1,100 turns a month, and 73% of them ended in a pass.
- **Named lines:** a line that names the agent (the ask lane) still goes at once, carrying everything unsent with it.
- **Other talk:** unnamed talk (the context lane) waits out `CONTEXT_MIN_GAP_MS` (3 minutes) after the last context chunk. One scheduled run at the gap's end delivers what it held, so a room that falls silent does not keep it.
- **Exceptions:** a hold's catch up, a new route's backlog and the end of the call are never gapped.

## AC4. Monitoring

`packages/evals/org-comms/monitor.py` reruns the measurement:
1. Exports from prod.
2. Places each sender against its recipient.
3. Reads a random sample inside the recipients' transcripts.
4. Labels the sample through `prompt-dry-run.ts`.
5. Writes `report.json` and `report.md` under `$CODECAST_EVALS_HOME/org-comms/runs/<date>/`, set against `baseline.json` (the founding study) and every earlier run.

A weekly spawned trigger runs it and iterates. A change to the wording is proven before it ships with the synthetic suite in `packages/evals/org-comms/suite`:
- `run.py` and `stats.py` run the scenario ablation, graded in code by `scenarios.py`;
- `sim.py` runs the multi-agent world (`WORLD=big LEAD_FEED=1` for ten workers with a lead digest).

Every run uses a saved account profile (`--account`), so a machine login switch cannot break it.

**What to watch, and what each number means:**

| Metric | Baseline | Means trouble when |
|---|---|---|
| Unnamed huddle chunks a week | about 255 | it does not fall after AC3 |
| Huddle noise | 73% | it stays high: the gap is too short |
| Agent-to-agent noise | 7% | it rises: chatter is coming back |
| Could have been read, not urgent, changed nothing | 22% | it rises: the "write it down" half is not holding |
| Out-of-line direction followed | 64% | it rises without coordination as the kind: peers are steering each other |
| Hub share | 52% | a new hub appears outside any role |

## AC5. Open proposals

- **Holds and claims as objects** (`cast hold`, `cast claim`), checked by the push and deploy paths. They would turn most coordination messages into reads.
- **Integration owners seated as roles.** The busiest informal hubs are release and merge drivers.
