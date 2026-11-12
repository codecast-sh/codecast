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
- **Other talk:** unnamed talk (the context lane) waits out `CONTEXT_MIN_GAP_MS` (1 minute since Oct 22, 3 minutes before) after the last context chunk, whether the scribe's lull or the agent's own turn ending asks for the delivery. One scheduled run at the gap's end delivers what it held, so a room that falls silent does not keep it.
- **Exceptions:** a hold's catch up (`cast call hold`), a new route's backlog and the end of the call are never gapped.

## AC4. Monitoring

`packages/evals/org-comms/monitor.py` reruns the measurement:
1. Exports from prod.
2. Places each sender against its recipient. A session's lead is its parent, else the session that spawned it (`spawned_by_conversation_id`: a plain `cast spawn`, or a Line run handing a station its brief), and the recipient's own row settles its lead even when that session is outside the export. Codecast's own notices (a reporting line moved, a send still queued) are counted apart and left out of both the huddle and the agent numbers. A short id shared by several sessions resolves to the one closest to the recipient's line. Sessions older than the export are looked up by id, and role anchors come from each team's org listing.
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
| Unnamed chunks inside the delivery gap | 92% (2026-10-13, before the fix) | it is not near zero: something delivers around the gap. The monitor reads the gap from `transcripts.ts` |
| Huddle noise | 73% (27 to 33% on Nov 3 at the 1 minute gap) | it stays high: the gap is too short |
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


### 2026-10-22 (week since delivery was fixed, 300 cases)

2,624 messages over Oct 15 to 22, 299 agent to agent cases and 1 huddle case read.

- **Delivery holds.** Since Oct 15, about 99% of sessions that run the start hook see `<org-context>` (305 of 308 on Oct 22). The 599 sessions on Oct 17 and 18 with no start hook were a film-generation harness running in `/tmp` sandboxes, not org agents.
- **First separated effect of the wording: noise.** Pooling the Oct 20 and Oct 22 samples (392 cases with a known sender), noise is 1.9% (5 of 270) from senders that saw the guidance and 7.4% (9 of 122) from senders that did not, Fisher p = 0.014. The gap sits in parents messaging their own workers (2 of 71 against 5 of 55); role and worker-to-parent rates are close. Nearly every noise case from the "did not see" group is a long-running parent or lead repeating what the recipient already had (a late duplicate report, a restated hold, a fix already made), so the groups differ in session age as well as in the guidance. Idle messages (4.8% against 6.6%), out-of-line direction (18.5% against 22.1%) and changed recipient (56% against 61%) do not separate.
- **Peer share is slightly higher among senders that saw it (14% against 8%, p = 0.10), and those peer messages are what the policy sends direct:** 11 of 39 are coordination, 16 urgent, 21 changed the recipient, none noise. Overall peer share held at 10%.
- **Leads keep relaying more.** Role messages that name another session: 13% (Sep 6 to Oct 5), 23% (Oct 6 to 14), 27% (117 of 429, Oct 15 to 22).
- **Week totals:** idle messages with asked-for results left out 6.0% (baseline 14.8%), the lowest yet; agent noise 4.0%; peer share 10.2%; out-of-line direction followed 68% (baseline 64%); hub share with a recipient's own workers left out 34%. Volume 0.54 messages per new session, still led by orchestrators and their workers.
- **Huddle:** 3 unnamed chunks all week, none inside the gap.
- **No wording change.** The remaining noise comes from long-running sessions and should shrink as they pick the guidance up at their next compaction or resume. Next run: re-test noise with the Oct 27 sample pooled in, comparing within parent-to-worker only.

### 2026-10-27

2,239 messages over Oct 20 to 27 (2,624 last week), 120 agent to agent cases read, no huddle cases.

- **Messages per new session fell to 0.17 (0.54), and traffic did not.** The denominator moved: Ashot's account created 13,478 sessions this week (5,880 on Oct 23), most of them agentwatch and judge_review harness runs that send no messages. Read this row against the message count until the monitor counts only sessions that ran the start hook.
- **The monitor left 221 messages (10%) unplaced. Fixed for 88 of them.** Every user together now creates about 27,000 sessions a week, so the newest-70,000 export reached back only to Sep 30. The by-id fallback (`cast sessions`) searches only the person's inbox. That missed role anchor sessions, which belong to each role's bot user (the Market Growth and Calling leads among them, 83 messages), and teammates' private or deleted sessions, which Ashot cannot open (`cast read` says not found). The export now takes 100,000 rows, the most one `convex data` call returns, and anchors are placed from `cast org ls --json` for each of the person's teams. 133 stay unplaced; most come from sessions the person cannot see, which is correct.
- **Out-of-line direction followed 85% (33 of 39 directing cases outside the spawn line).** Reading them, none is a peer steering a peer. 23 involve role sessions: landing requests to the Release Captain, leads answering or redirecting work in their area, a hold on a stray controller. 11 are a Line run handing its brief back to the session at a station; the run is that session's driver, and the monitor files it as peer or unplaced because a station is not a spawn parent. No wording change.
- **Hub share with a recipient's own workers left out 38% (34%).** The top hubs are roles: Agent Quality lead (114 messages from 35 senders), Release Captain (112 from 48), Eval Suite lead (81 from 30). Leads hearing from many is the policy, and the Release Captain is AC5's integration owner, now seated. No informal hub outside a role in the top five.
- **Noise separates again with three weeks pooled.** Over 517 distinct cases from the Oct 20, 22 and 27 samples: 1.9% (6 of 321) from senders that saw the guidance against 6.9% (11 of 159), Fisher p = 0.007. Within parent to worker it is 2 of 77 against 7 of 71 (p = 0.065), close but not separated; elsewhere 4 of 244 against 4 of 88. This week alone: noise 2.5%, idle messages with asked-for results left out 7.5%, peer share 8.6%, changed recipient 68%.
- **Huddle:** 2 unnamed chunks, none inside the gap.
- **Next run:** whether unplaced messages stay near 6%; place Line station hand-backs as the session's own line; keep pooling parent-to-worker noise.

### 2026-11-03

1,176 messages over Oct 27 to Nov 3 (2,239 last week), 105 agent to agent and 15 huddle cases read.

- **Volume halved, and messages per new session is back to 0.60** because the harness flood that made last week's 0.17 is gone (1,958 sessions created, 13,478 last week). Role sessions carry 45% of messages.
- **The monitor placed every message. Fixed.** Last week's open item: 161 messages (14%) were unplaced and Line hand-backs were filed as peer. The monitor read only `parent_conversation_id`, but a Line station and a plain `cast spawn` record their driver in `spawned_by_conversation_id`. It now reads both, and the recipient's own row settles its lead even when the driver is outside the export and a stranger with the same 7 character prefix is inside it (4 Line hand-backs were placed as peer that way). Unplaced 161 to 0, parent to worker 114 to 328, peer share 8.6% to 3.9%. Earlier columns are not restated, so the peer share drop is mostly placement.
- **Huddle: 96 unnamed chunks, nearly all a minute apart, as designed.** Two fed calls (Oct 28, Nov 3, both to Pearl or Basil). Commit 599999d0d (Oct 22) cut `CONTEXT_MIN_GAP_MS` to 1 minute so an agent following the room does not hear it three minutes late; the monitor still tested against 3 minutes and reported 99% inside the gap. It now reads the gap from code: 0% inside. Huddle noise is 27 to 33% across two labelings (4 or 5 of 15, each a bare pass on chatter), against 73% at baseline, so the shorter gap costs little. AC3 updated.
- **Out-of-line direction followed 89% (23 of 26).** 22 of the 30 directing cases in the first labeling involve role sessions: routed tasks and assignments, prod incidents sent to Operations, landing and CI asks. The rest are CI red on main sent to the commit's author. No peer steering, no wording change.
- **A hub outside any role, third week: the Line pipeline session (jx7d8av).** 74 messages from sessions that are not its workers, 67 of them from role leads (Agent Quality 41, Eval Suite 11, Operations 10, Calling 5). The Agent Quality lead treats it as the owner of Line infrastructure: it answers its sweeps, relays Evals' and Operations' findings to it, and decides holds and resumes. The cases read changed the recipient or were absorbed, none noise. It works, but no role names the Line, so `cast route` cannot find this owner and nothing replaces it when the session goes. Queued to Ashot as a decision on seating it.
- **Noise keeps separating.** Pooled over four weeks, 1.6% (6 of 364) from senders that saw the guidance against 6.7% (12 of 178), one-sided p = 0.003. This week alone 0 of 43 against 1 of 19. Agent noise 1.9%, idle messages with asked-for results left out 4.8% (the lowest yet), changed recipient 71%.
- **Next run:** whether peer share holds near 4% under the new placement; huddle noise if calls continue; the Line hub against the decision.

### 2026-11-11 (8 days since Nov 3; the Nov 10 week was not measured on its own)

4,656 messages over Nov 3 to 11 (1,176 in the 7 days before), 115 agent to agent and 5 huddle cases read. The Nov 10 run hit a usage limit before it began, so this one window covers both weeks.

- **Volume quadrupled, mostly in parent to worker traffic (1,809) and Union's ad launches.** 1,569 messages came on Nov 11 alone, most between 00:00 and 03:00 UTC, from one portfolio session (jx77htq) and its workers. Messages per new session fell to 0.12 because 39,458 sessions were created, most of them Line triage and onefix runs and market simulations that send nothing; read the message count instead.
- **Peer share rose to 10.5% (3.9%), and most of the rise is one split thread, not peers steering each other.** Codex ingest on MacBook-Pro-182 threw "invalid ingest result schema" 161,719 times over 254 session files from 05:56Z to 10:34Z on Nov 11. Worker jx729j7's launcher thread synced as a new parentless session (jx746pq, "Ads launch pipeline") instead of into jx729j7, so its 126 messages with jx7eahf's tree have no lead and count as peer. The ones read are launch readbacks, ad ids, brief handoffs and an urgent pause of live ads that leaked raw tokens. Filed to Engineering as ct-92470 (fix the rejection, find the other split threads). Found by a duplicate run of this routine (jx79kt4).
- **The monitor mismeasured twice. Both fixed.**
  - `cast teams` stopped printing team ids, so the anchor lookup found no team and placed no role anchors: 223 messages were unresolved. It reads `cast teams --json` now, and unresolved is down to 50.
  - `cast read <link> -c N` filled its 24K page forward from the first context line. When the turns before a linked message were long, the message fell off the page, and a linked message larger than the page showed no reply. 39 of 120 cases were unjudgeable, and "changed recipient" read 49%. `fitReadPage` (`packages/cli/src/formatter.ts`) now keeps the linked message and grows outward from it, and gives an oversized one half the page. Every agent following a message link had the same blind spot. 8 cases are still unclear.
  - The first run's columns are not kept. This week's numbers are after both fixes.
- **Out-of-line direction followed 65% (15 of 23 directing cases), down from 88.5% and at baseline (64%).** The cases are sibling contract asks, coordination over migrations and a shared render lock, a hazard (broken ads possibly live on Meta, paused at once), and role assignments. No peer pulled a session off its work. No wording change.
- **Agent noise 4.3% (5 of 115; 1.9% last week).** Two are a Line run re-handing a station the same brief, one a confirmation of a deploy the recipient had seen, two a finding the recipient already had. Within the 2 to 5% band of earlier weeks; watch whether the repeated brief recurs.
- **Idle messages with asked-for results left out 7.0% (4.8%), changed recipient 66%.** Hub share with a recipient's own workers left out fell to 25% (38%), the lowest yet: the busiest outside-the-line hubs are the Head of Infrastructure (95 messages from 20 senders) and the split launcher thread.
- **The Line pipeline session (jx7d8av), for comparing before and after the Line lead (sd-2402, now proposal op-150 waiting on Ashot):** 111 messages from 35 senders, 58 of them from 17 senders that are not its workers (Eval Suite 12, Engineering 11). On Nov 3, over 7 days: 77 from 15, and 65 from 9.
- **Huddle:** 112 unnamed chunks, none inside the 1 minute gap; 0 of 5 read were noise.
- **Guidance split is no longer readable here:** 58 of 115 senders are "unknown" because their transcripts live on Line hosts and other machines, and only 4 are "did not see". Pooling stops until the monitor can read the guidance flag from the session row.
- **Next run:** peer share once ct-92470 relinks split threads; whether the Line run's repeated brief recurs as noise; jx7d8av after op-150 is decided.
