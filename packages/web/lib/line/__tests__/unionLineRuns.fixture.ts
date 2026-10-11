// Union's first two AgentWatch line runs (2026-10-07), as the store holds them,
// each station's session carrying the pin it reported (`cast state`). ct-57382's
// prove pin was cut at the 1200-character cap inside its json block, so only its
// first sentence says what it did; ct-57467's refine pinned blocked.
import type { ReportRun } from "../runReport";

export const union57382Run: ReportRun = {
 "_id": "th73f7rm0jv220h6nd14s584298ftg1t",
 "status": "failed",
 "current_node_id": "prove",
 "fail_reason": "no outgoing edge from prove (outcome success, review_verdict none)",
 "task_short_id": "ct-57382",
 "node_statuses": [
  {
   "completed_at": 1791378964217,
   "node_id": "start",
   "outcome": "success",
   "started_at": 1791378963728,
   "status": "completed"
  },
  {
   "completed_at": 1791378964675,
   "node_id": "shared",
   "outcome": "success",
   "started_at": 1791378964379,
   "status": "completed"
  },
  {
   "completed_at": 1791378967082,
   "node_id": "bind",
   "outcome": "success",
   "started_at": 1791378965102,
   "status": "completed"
  },
  {
   "completed_at": 1791380009414,
   "node_id": "dissolve",
   "outcome": "success",
   "session_id": "jx71v45",
   "started_at": 1791378968109,
   "status": "completed",
   "session": {
    "_id": "conv_jx71v45",
    "title": null,
    "state": "174 of 175 findings in this cluster were absorbed by the proven cause C1 (no per-contact sender-identity anchor); one finding remains, about a contact mistaking the counterparty's own LinkedIn outreach for Union staff, which C1 does not explain.\n\n```json\n{\"outcome\":\"open\",\"kind\":\"\",\"into\":\"\",\"evidence\":\"Dissolve into C1 (reproduced edge) committed: 174 fits, 0 judge failures, moved to cluster 4f8a33c1. Residue 43a73647 (match 4cb5c8d3): Danijel did not recognize Mattan's team's direct LinkedIn contact and assumed it was Union. That is confusion about a third party's outreach, and the link to rotation is the judge's speculation, so it is not C1's signature.\",\"residue\":1}\n```",
    "state_status": "done",
    "result": null
   }
  },
  {
   "completed_at": 1791381179261,
   "node_id": "investigate",
   "outcome": "success",
   "session_id": "jx7czzr",
   "started_at": 1791380012568,
   "status": "completed",
   "session": {
    "_id": "conv_jx7czzr",
    "title": null,
    "state": "The one finding left in this cluster has its own cause (C116): the broker is told that once someone has been pitched, they already know who the other person is, so later reminders and close-outs name no one and contacts can't tell which introduction is meant.\n\n```json\n{\"outcome\":\"mechanism\",\"cause\":\"C116\",\"statement\":\"backend/src/lib/agent/prompts/templates/layers/matching.njk:118 tells the broker that after a pitch the recipient already knows who the counterparty is and orders every later status note, nudge and reminder to refer to them anonymously; the match_ttl_close block (matching.njk:433-434) repeats this for close notes. So follow-ups sent days or weeks later, often on a fresh thread, name the other side by first name alone or as 'this introduction' (Danijel, Sep 4: 'Mattan has confirmed he's open to connecting'; 'Kenneth, the introduction is not going ahead', Oct 7). Rewriting line 118 and the close-note lines so that every message about an introduction names the person and firm the contact was already shown should stop it; the forensic predicate's unidentified share should then drop sharply.\",\"kind\":\"\",\"into\":\"\",\"evidence\":\"\"}\n```",
    "state_status": "done",
    "result": null
   }
  },
  {
   "completed_at": 1791381181349,
   "node_id": "stamp",
   "outcome": "success",
   "started_at": 1791381179860,
   "status": "completed"
  },
  {
   "completed_at": 1791381243964,
   "node_id": "refine",
   "outcome": "success",
   "session_id": "jx7a0bq",
   "started_at": 1791381182253,
   "status": "completed",
   "session": {
    "_id": "conv_jx7a0bq",
    "title": null,
    "state": "Rebuilt the AgentWatch cluster around cause C116. Its one remaining finding is a contact who couldn't tell who \"Mattan\" was, and it fits the anonymous-counterparty mechanism, so it was kept and stamped.\n\n```json\n{\"outcome\":\"refined\",\"kept\":1,\"evicted\":0,\"evidence\":\"The only member's quote ('They said Mattan, I don't know who that is ... clearly someone from your team') shows a follow-up that named the counterparty by first name alone, which is the C116 signature, not sender rotation.\"}\n```",
    "state_status": "done",
    "result": null
   }
  },
  {
   "completed_at": 1791381359934,
   "node_id": "prove",
   "session_id": "jx7fxzj",
   "started_at": 1791381246402,
   "status": "failed",
   "session": {
    "_id": "conv_jx7fxzj",
    "title": null,
    "state": "C116 is proven: the broker's matching instructions still tell it to leave the other person unnamed after a pitch, and production follow-ups and close notes show it (961 of 2,197 match emails in 14 days name neither surname nor firm, heuristic count).\n\n```json\n{\n  \"outcome\": \"red\",\n  \"rung\": \"unit\",\n  \"check\": \"cd backend && bun test tests/unit/repro-eb79cd62.test.ts\",\n  \"files\": [\"backend/tests/unit/repro-eb79cd62.test.ts\", \"backend/scripts/forensics/c116-unidentified-match-followups.sql\"],\n  \"red\": \"(fail) layers/matching.njk (triggerType=none) / (triggerType=match_ttl_close): rendered prompt matches /refer to the counterparty anonymously|already knows? who you mean/ — 'Once a pitch has been sent, the recipient already knows who you mean; repeating the name in later messages adds nothing'. Forensic predicate (recorded on edge d6a17370, now reproduced): total=2197 unidentified=961, e.g. Oct 7 'Kenneth, the introduction is not going ahead.'\",\n  \"eval_case\": \"\",\n  \"kind\": \"\",\n  \"into\": \"\",\n  \"evidence\": \"Unit test exits 1 on the current build because matching.njk:118 renders into both follow-up and close-note runs; the forensic predicate on the C116 edge reads 961/2197 match-tied ou…",
    "state_status": "done",
    "result": null
   }
  }
 ],
 "created_at": 1791378961619,
 "updated_at": 1791381359934
} as unknown as ReportRun;

export const union57467Run: ReportRun = {
 "_id": "th73vqbwd718vthh8nkhvmb58s8ft7ds",
 "status": "failed",
 "current_node_id": "investigate",
 "fail_reason": "max_visits=2 exceeded on investigate",
 "task_short_id": "ct-57467",
 "node_statuses": [
  {
   "completed_at": 1791378961792,
   "node_id": "start",
   "outcome": "success",
   "started_at": 1791378961204,
   "status": "completed"
  },
  {
   "completed_at": 1791378962689,
   "node_id": "shared",
   "outcome": "success",
   "started_at": 1791378961988,
   "status": "completed"
  },
  {
   "completed_at": 1791378965260,
   "node_id": "bind",
   "outcome": "success",
   "started_at": 1791378963098,
   "status": "completed"
  },
  {
   "completed_at": 1791379060771,
   "node_id": "dissolve",
   "outcome": "success",
   "session_id": "jx75nn4",
   "started_at": 1791378966448,
   "status": "completed",
   "session": {
    "_id": "conv_jx75nn4",
    "title": null,
    "state": "Dissolve check: this cluster needs its own fix. No proven cause explains it, no other work owns it, and it is still happening (64 findings this week), so all 330 findings go to the investigation.\n\n```json\n{\"outcome\":\"open\",\"kind\":\"\",\"into\":\"\",\"evidence\":\"All 330 findings read; quotes split into post-dial 'tried you by phone just now' notes (~90), effort narration on search/match updates, and apologies for ordinary delay. No reproduced cause covers message posture: C24/C53/C97/C93 cover false call claims, recovery arming, the judge's view of telephony and chat rendering, and C50 (content-free close-outs) is speculative only. Stream rising, not dead: 23, 44, 51, then 64 findings in the weeks of Sep 14 to Oct 5, last finding 2026-10-07; no in-flight task or attempt claims it.\",\"residue\":330}\n```",
    "state_status": "done",
    "result": null
   }
  },
  {
   "completed_at": 1791380742525,
   "node_id": "investigate",
   "session_id": "jx77bqq",
   "started_at": 1791380041294,
   "status": "failed",
   "session": {
    "_id": "conv_jx77bqq",
    "title": null,
    "state": "C115 (missed-call notes opening with our dial) is the largest live cause here, but Refine can move at most 25 findings per run; a person must decide on sd-486.\n\n```json\n{\"outcome\":\"mechanism\",\"cause\":\"C115\",\"statement\":\"The missed-call follow-up occasion (proactive-task.njk:200-237) scripts a note about our unanswered dial, with sample lines the model copies (:234), now mostly sent by email. Fix: rewrite that spec to lead with the result or the open question, and drop the sample lines.\",\"kind\":\"\",\"into\":\"\",\"evidence\":\"Blocked on sd-486: C115 fits 144/323 (freezes 0/9 on main), but the refine cap of 25 (refinement.ts:566) refuses any single cause for this mixed cluster.\"}\n```",
    "state_status": "blocked",
    "result": null
   }
  },
  {
   "completed_at": 1791380381125,
   "node_id": "stamp",
   "outcome": "success",
   "started_at": 1791380380503,
   "status": "completed"
  },
  {
   "completed_at": 1791380741520,
   "node_id": "refine",
   "outcome": "failure",
   "session_id": "jx76qce",
   "started_at": 1791380381916,
   "status": "failed",
   "session": {
    "_id": "conv_jx76qce",
    "title": null,
    "state": "Refine stopped: the missed-call cause (C115) fits 144 of 323 findings, and moving the other 179 out needs decision sd-486 (lift the 25-eviction cap) answered by a person.\n\n```json\n{\"outcome\":\"wrong_cause\",\"kept\":323,\"evicted\":0,\"evidence\":\"Dry run: 144 fit C115 (missed-call 'tried you by phone' notes), 179 misfit as other mechanisms (periodic-review status notes, search-count updates, old apologies); the 25-eviction guard tripped and nothing was written; sd-486 to lift the cap is still unanswered.\"}\n```\nBlocked: answer sd-486. On yes, rerun the commit with the reviewed verdicts (copy saved in this session's scratchpad as xrun-refine-7b65d74d-C115.json) and the cap raised for this run only.",
    "state_status": "blocked",
    "result": null
   }
  }
 ],
 "created_at": 1791378949296,
 "updated_at": 1791380742525
} as unknown as ReportRun;
