// Two AgentWatch line runs in the shape the store holds them, each station's
// session carrying the pin it reported (`cast state`). The text is synthetic;
// the repo is public. ct-57382's prove pin is cut at the 1200-character cap
// inside its json block, so only its first sentence says what it did;
// ct-57467's refine pinned blocked.
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
    "state": "174 of 175 findings in this cluster were absorbed by the proven cause C1 (one sender identity shared across contacts); one finding remains, about a contact mistaking a partner's own outreach for ours, which C1 does not explain.\n\n```json\n{\"outcome\": \"open\", \"kind\": \"\", \"into\": \"\", \"evidence\": \"Dissolve into C1 (reproduced edge) committed: 174 fits, 0 judge failures, moved to cluster c-0002. Residue f-0001: a contact took a partner's direct outreach for ours. That is confusion about a third party, and the link to C1 is the judge's guess, so it is not C1's signature.\", \"residue\": 1}\n```",
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
    "state": "The one finding left in this cluster has its own cause (C116): the assistant is told that once an introduction is sent, the contact already knows who the other side is, so later reminders and close notes name no one and contacts can't tell which introduction is meant.\n\n```json\n{\"outcome\": \"mechanism\", \"cause\": \"C116\", \"statement\": \"templates/followup.njk:40 tells the assistant that after an introduction the contact already knows the other side and orders every later reminder and close note to refer to them anonymously. Follow-ups sent days later, often on a new thread, name the other side by first name alone. Rewriting that line so each message names the person and firm the contact was shown should stop it.\", \"kind\": \"\", \"into\": \"\", \"evidence\": \"\"}\n```",
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
    "state": "Rebuilt the AgentWatch cluster around cause C116. Its one remaining finding is a contact who couldn't tell who a first-name-only follow-up meant, and it fits the anonymous-counterparty mechanism, so it was kept and stamped.\n\n```json\n{\"outcome\": \"refined\", \"kept\": 1, \"evicted\": 0, \"evidence\": \"The only member's quote ('I don't know who that is') shows a follow-up that named the other side by first name alone, which is the C116 signature.\"}\n```",
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
    "state": "C116 is proven: the follow-up instructions still tell the assistant to leave the other side unnamed after an introduction, and sampled follow-ups and close notes show it (412 of 1,000 sampled follow-ups name neither surname nor firm, heuristic count).\n\n```json\n{\n  \"outcome\": \"red\",\n  \"rung\": \"unit\",\n  \"check\": \"cd app && bun test tests/unit/repro-0001.test.ts\",\n  \"files\": [\"app/tests/unit/repro-0001.test.ts\", \"app/scripts/forensics/c116-unnamed-followups.sql\"],\n  \"red\": \"(fail) templates/followup.njk (kind=reminder) / (kind=close): rendered prompt matches /refer to the other side anonymously/: 'Once an introduction is sent, the contact knows who you mean; do not repeat the name'. Forensic predicate (recorded on edge e-0001, now reproduced): total=1000 unnamed=412, e.g. a close note that names nobody.\",\n  \"eval_case\": \"\",\n  \"kind\": \"\",\n  \"into\": \"\",\n  \"evidence\": \"The unit test exits 1 on the current build because followup.njk:40 renders into both reminder and close-note runs; the forensic predicate on the C116 edge reads 412/1000 sampled follow-ups with neither a surname nor a firm, and the sample of twelve read by hand agrees with it in every case so far, which is why the rung is…",
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
    "state": "Dissolve check: this cluster needs its own fix. No proven cause explains it, no other work owns it, and it is still happening (64 findings this week), so all 330 findings go to the investigation.\n\n```json\n{\"outcome\": \"open\", \"kind\": \"\", \"into\": \"\", \"evidence\": \"All 330 findings read: notes that open with our missed call, effort narration on updates, and apologies for ordinary delay. No reproduced cause covers message posture; C50 is speculative only. Rising each week, last finding today; no open task claims it.\", \"residue\": 330}\n```",
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
    "state": "C115 (missed-call notes opening with our dial) is the largest live cause here, but Refine can move at most 25 findings per run; a person must decide on sd-486.\n\n```json\n{\"outcome\": \"mechanism\", \"cause\": \"C115\", \"statement\": \"The missed-call follow-up template scripts a note about our unanswered call, with sample lines the model copies. Fix: lead with the result or the open question, and drop the sample lines.\", \"kind\": \"\", \"into\": \"\", \"evidence\": \"Blocked on sd-486: C115 fits 144/323, but the refine cap of 25 refuses any single cause for this mixed cluster.\"}\n```",
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
    "state": "Refine stopped: the missed-call cause (C115) fits 144 of 323 findings, and moving the other 179 out needs decision sd-486 (lift the 25-eviction cap) answered by a person.\n\n```json\n{\"outcome\": \"wrong_cause\", \"kept\": 323, \"evicted\": 0, \"evidence\": \"Dry run: 144 fit C115, 179 misfit as other mechanisms; the 25-eviction guard tripped and nothing was written; sd-486 is still unanswered.\"}\n```\nBlocked: answer sd-486. On yes, rerun the commit with the reviewed verdicts and the cap raised for this run only.",
    "state_status": "blocked",
    "result": null
   }
  }
 ],
 "created_at": 1791378949296,
 "updated_at": 1791380742525
} as unknown as ReportRun;
