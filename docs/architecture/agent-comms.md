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
- **Other talk:** unnamed talk (the context lane) waits out `CONTEXT_MIN_GAP_MS` (3 minutes) after the last context chunk, whether the scribe's lull or the agent's own turn ending asks for the delivery. One scheduled run at the gap's end delivers what it held, so a room that falls silent does not keep it.
- **Exceptions:** a hold's catch up (`cast call hold`), a new route's backlog and the end of the call are never gapped.

## AC4. Monitoring

`packages/evals/org-comms/monitor.py` reruns the measurement:
1. Exports from prod.
2. Places each sender against its recipient. Codecast's own notices (a reporting line moved, a send still queued) are counted apart and left out of both the huddle and the agent numbers. A short id shared by several sessions resolves to the one closest to the recipient's line.
3. Reads a random sample inside the recipients' transcripts, drawn only from sessions the person owns: a message they sent into a teammate's session is counted and never opened. A huddle chunk is unnamed talk only when its header says nobody named the agent; a voice handoff, a chat line and the attach briefing are asks or one-offs.
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
| Unnamed chunks inside the 3 minute gap | 92% (2026-10-13, before the fix) | it is not near zero: something delivers around the gap |
| Huddle noise | 73% | it stays high: the gap is too short |
| Agent-to-agent noise | 7% | it rises: chatter is coming back |
| Could have been read, not urgent, changed nothing | 22% | it rises: the "write it down" half is not holding |
| Out-of-line direction followed | 64% | it rises without coordination as the kind: peers are steering each other. Read who received it first: a lead directing a lead it manages and an ask to the owner of a file are both counted here and are the policy working |
| Hub share | 52% | a new hub appears outside any role |
| Hub share, own workers' reports left out | 29% (2026-10-20) | it rises: a session is hearing from many it did not spawn. An orchestrator's workers reporting back fill the plain row and are the line working |

## AC5. Open proposals

- **Holds and claims as objects** (`cast hold`, `cast claim`), checked by the push and deploy paths. They would turn most coordination messages into reads.
- **Integration owners seated as roles.** The busiest informal hubs are release and merge drivers.

## AC6. Weekly log

### 2026-10-13

First week under the policy and the huddle gap (700 messages, 109 agent to agent and 10 huddle cases read).

- **Huddle delivery: the gap was not holding. Fixed and deployed.** Unnamed chunks fell from 649 to 49 a week, but the week held only two fed calls, and pacing was not the reason: 92% of consecutive unnamed chunks still reached the session under 3 minutes apart (median 40 seconds), and 6 of the 10 read ended in a pass. Cause: only the scribe's lull waited out the gap. A context chunk costs the agent a turn, the end of that turn asks for delivery again as a `settle`, and `settle` was exempt, so each pass shipped the next chunk seconds later. `sessionDeliveryVerdict` now gaps a turn's end too; the gap's own closing run arrives after the gap and still delivers. Watch the new "inside the gap" row fall toward zero.
- **Out-of-line direction followed rose to 79% (27 of 34, baseline 64%), and reading the cases says it is not peers steering each other.** 7 were a lead directing a lead it manages (the org line, which the monitor does not yet place); 15 went to top level sessions whose lead is the person reading the turn; 10 went to workers, all asks about files or a contract the recipient owns, sent by a sibling or a peer under the same plan. No case showed a session pulled off its work by a peer. No wording change. The number moved 70, 83, 79 across three labelings of nearly the same sample, so at this size it is good to about ten points.
- **Hub share 37% (baseline 52%).** Role sessions now receive 8% of agent traffic. The largest hub is new and outside any role: two top level sessions building the Line (jx7d8av and jx7e4fy) exchanged 73 messages, 11% of the week, over files they both edit. The cases read are productive (asks, answers, collision avoidance; one readable). It is the pair AC5's claims and an integration owner role are meant for; left alone this week, watched for a second week before proposing a seat.
- **Agent noise 5.5%, read idle unchanged 21%:** at baseline. 4 of the 6 noise cases are one lead (jx723v8) telling workers that had finished to keep going.
- **Monitor corrected.** It counted 45 system notices as traffic (32 "You now report to" notices as huddle chunks, 13 delivery notices as agent messages), and resolved a sender by a short id that 4,141 sessions share, which placed some parents as peers (22 of 228). It also reused a cached label when the cases under a batch number had changed. All three fixed; this week's numbers are after the fix, earlier columns are not restated.


### 2026-10-16 (mid-week read, last 3 days)

624 messages, 120 agent to agent cases read, no huddle cases (one 19 minute call since the Oct 13 fix fed no agent).

- **The guidance reached almost nobody until Oct 15.** Claude Code cuts session-start output over about 9.8KB to a 2KB preview, and `<org-context>` came after the feed, so no session on this machine saw it from Oct 1 to 12, and 4 of about 400 did on Oct 13. The start hook now puts it first under a 9,000-byte budget: 108 sessions saw it on Oct 15 and 66 so far on Oct 16, with 1 cut. Everything measured before Oct 15, including the Oct 13 conclusion that no wording change was needed, measured the old behavior plus the huddle gap and the routine prompt, which reach leads through trigger frames and were never cut. Long-lived sessions started before the fix get the block at their next compaction or resume; 18 of this sample's 120 came from senders that saw it, too few to compare.
- **Traffic moved onto the line.** Peer share 10% (baseline 56%, Oct 13 32%). Role sessions now carry 27% of messages. The remaining peer messages are the kind the policy keeps direct: 60% urgent, 73% changed the recipient.
- **Leads relay.** Messages from role sessions that name another session rose from 13% (59 of 455, Sep 6 to Oct 5) to 25% (67 of 264, Oct 6 to 16). A sample read as real synthesis: pointing a lead at another area's open card on the same question, telling a worker which fixes already cover its task, handing a worker prior findings so it does not re-derive them. New roles were seated in the same period, so part of the rise is more leads.
- **Idle messages keep falling.** "Could have been read" rose to 33%, but 14 of the 24 such cases are a worker's one finished result to the parent that spawned it, the handoff the messaging guidance asks for. Leaving asked-for results out, messages that could have been read, were not urgent and changed nothing went 14.8% (baseline), 11.0% (Oct 13), 7.5% (now). The monitor reports both rows from now on.
- **Volume rose with the org's own work**, 0.25 messages per new session (0.15 last week), led by role sessions (Head of Growth received 51, Match Funnel 32, Agent Quality 22). Agent noise is 1.7%.
- **The Line pair persists as a hub outside any role**: 21 messages between jx7d8av and jx7e4fy in three days, and jx7d8av heard from 11 sessions. jx7d8av is now dormant with its build done; propose an integration owner only if a third week shows it.
- **Monitor corrected.** Long-lived sessions (role standing sessions above all) fell outside the newest-70,000 session export and left 25% of messages unplaced; they are now looked up by id with `cast sessions` (1 of 624 unplaced).
- **Next week is the first real read of the wording.** The monitor now splits each sample by whether the sender's start showed it the guidance (`by_guidance` in report.json; read from the transcript head on this machine). Compare `saw` with `did not see` on peer share, out-of-line direction and idle messages once `saw` has 50 or more cases.

### 2026-10-20

2,247 messages (700 on Oct 13), 120 agent to agent cases read, no huddle cases.

- **Volume tripled, on the line.** 0.47 messages per new session (0.25 on Oct 16, baseline 0.60). Parent to worker and worker to parent are 62% of it, led by one orchestrator (jx716vh) running waves of workers: 325 messages in, 234 of them its own workers' reports. Peer share held at 10.5%; agent noise 3.3%, idle 18.3%, below baseline.
- **Hub share 57% (baseline 52%) is that orchestrator, not a new hub.** With a recipient's own workers' reports left out it is 29%, now a row of its own. The busiest remaining hubs are two of jx716vh's workers hearing from their parent (54 and 39 messages) plus a sibling pair between them (27), and the Growth and Match Funnel leads. The Line pair from Oct 13 and 16 is gone: jx7e4fy no longer appears, and 119 of jx7d8av's 144 messages are with its own 276 workers. No integration owner proposal.
- **Routed requests reached the role twice. Fixed.** `cast route` filed the task for the role, which tells the role's session (`announceAssignment`), and then woke it again with its own message; 4 of 5 routes this week sent both in the same second, and both noise cases from role leads were the second copy. The route's note ("routed to you, start it or say it needs starting") now rides on the one assignment notice, sent from the routing session (`tasks.create` `assignment_note` / `assignment_from`), with a test in `tasks.roleAssignee.test.ts`.
- **Out-of-line direction followed 75% (15 of 20).** The cases are a lead answering a worker's ask, sibling contract requests folded into a file being written, collisions on a shared file, and a lead the monitor does not yet place. No session pulled off its work by a peer. No wording change.
- **First guidance split with 78 senders that saw it** (38 did not): noise 1.3% vs 7.9%, idle 6.4% vs 10.5%, out-of-line direction 14% vs 18%, peer share 13% vs 5%. Every gap favors the guidance except peer share, none is separated at this size (noise 1 of 78 vs 3 of 38), and the groups differ in age as well as in the guidance. Keep pooling weeks.
- **Huddle: nothing to read.** One fed call (Oct 19). Its only unnamed chunk was the backlog of a route added mid call; the monitor's "inside the gap" 100% came from filing the attach briefing and a voice handoff as unnamed talk. Fixed in the monitor.
- **The monitor read teammates' sessions. Fixed.** It filtered on who sent a message, not who owns the recipient, so a message from Ashot's session into a teammate's session (a role standing session above all) was opened: at least 17 cases on Oct 13, 1 on Oct 16 and 2 this week (two role leads' sessions, which this run also read by hand while tracing the route duplicate). The sample now draws only recipients the person owns; the 40 such transcripts and their label batches are deleted from every run directory. Earlier columns include those cases and are not restated; this week's are after the fix.

