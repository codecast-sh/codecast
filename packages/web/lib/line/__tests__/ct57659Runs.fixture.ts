// ct-57659's line runs (2026-10-07), as the store holds them once each
// station's session is attached by its short id (workflow_runs.withAgentSessions).
// Run 2: Prove line's session was queued, then killed before its first message.
// Run 3: the builder (Build line, visit 2) handed off needs_context.
// Run 5: verify, green and eval printed raw text, no JSON result.
import type { ReportRun } from "../runReport";

export const ct57659Run2: ReportRun = {
 "_id": "th7068m95vdc3c0mmhyxsx26zh8fvqaf",
 "status": "failed",
 "current_node_id": "prove_line",
 "fail_reason": "no outgoing edge from prove_line (outcome success, review_verdict none)",
 "task_short_id": "ct-57659",
 "workflow_name": "line",
 "node_statuses": [
  {
   "completed_at": 1791394647531,
   "node_id": "start",
   "outcome": "success",
   "started_at": 1791394647358,
   "status": "completed"
  },
  {
   "completed_at": 1791394670054,
   "node_id": "ground",
   "outcome": "success",
   "session_id": "jx7fjy9",
   "started_at": 1791394648205,
   "status": "completed"
  },
  {
   "completed_at": 1791394725445,
   "node_id": "analyze",
   "outcome": "success",
   "session_id": "jx76mv3",
   "started_at": 1791394672066,
   "status": "completed"
  },
  {
   "completed_at": 1791395399737,
   "node_id": "prove_line",
   "session_id": "jx75tse",
   "started_at": 1791394726517,
   "status": "failed",
   "session": {
    "_id": "jx75tseye4hsp2wb19pk21y45n8ftdye",
    "title": "Prove line · ct-57659",
    "message_count": 0,
    "killed": true
   }
  }
 ],
 "created_at": 1791394644580,
 "updated_at": 1791395399737
};

export const ct57659Run3: ReportRun = {
 "_id": "th7ajf9dmps3r9w6pdphjp4g9d8ftbpq",
 "status": "failed",
 "current_node_id": "implement_line",
 "fail_reason": "no outgoing edge from implement_line (outcome success, review_verdict none)",
 "task_short_id": "ct-57659",
 "workflow_name": "line",
 "node_statuses": [
  {
   "completed_at": 1791395407768,
   "node_id": "start",
   "outcome": "success",
   "started_at": 1791395407501,
   "status": "completed"
  },
  {
   "completed_at": 1791395429895,
   "node_id": "ground",
   "outcome": "success",
   "session_id": "jx7ej7y",
   "started_at": 1791395408563,
   "status": "completed"
  },
  {
   "completed_at": 1791395462401,
   "node_id": "analyze",
   "outcome": "success",
   "session_id": "jx713z6",
   "started_at": 1791395430885,
   "status": "completed"
  },
  {
   "completed_at": 1791395570554,
   "node_id": "prove_line",
   "outcome": "success",
   "session_id": "jx78wwr",
   "started_at": 1791395464695,
   "status": "completed"
  },
  {
   "completed_at": 1791395574617,
   "node_id": "red",
   "outcome": "success",
   "result_preview": "{\"red\": true, \"dir\": \"/Users/ashot/src/codecast/.git/cast-line/line-ct-57659\", \"why\": \"repro.sh fails\"}",
   "started_at": 1791395572039,
   "status": "completed"
  },
  {
   "completed_at": 1791397008892,
   "node_id": "implement_line",
   "session_id": "jx7ajkg",
   "started_at": 1791396652919,
   "status": "failed",
   "session": {
    "_id": "jx7ajkgs868r1zeyt3n2mbx00h8ft9mb",
    "title": "Implement line · ct-57659",
    "message_count": 76,
    "handoff": {
     "status": "needs_context",
     "note": "Commit 9624f2fcb on codecast/line-ct-57659 (pushed), on top of 59558f59d. The branch is now 117 lines added and 11 removed against origin/main. Two of the three review findings are fixed. The third can't be done on this branch, which is why this is needs_context and not done."
    }
   }
  },
  {
   "completed_at": 1791396468634,
   "node_id": "verify",
   "outcome": "success",
   "result_preview": "no verify command configured in .codecast/workspace.toml ([verify] command = \"...\"); nothing to run",
   "started_at": 1791396467364,
   "status": "completed"
  },
  {
   "completed_at": 1791396469926,
   "node_id": "green",
   "outcome": "success",
   "result_preview": "bun test v1.3.14 (0d9b296a)\n\npackages/cli/src/workflow/proveFailRoute.test.ts:\n(pass) a failed Prove has a route > prove routes on failure with no proof json [0.54ms]\n\n 1 pass\n 0 fail\n 2 expect() calls\nRan 1 test across 1 file. [55.00ms]",
   "started_at": 1791396469083,
   "status": "completed"
  },
  {
   "completed_at": 1791396472263,
   "node_id": "eval",
   "outcome": "success",
   "result_preview": "no surface's sources differ from main; nothing to run\n\npass  $0.00  wrote /Users/ashot/src/codecast/.git/cast-line/line-ct-57659/eval-result.json (reps /Users/ashot/src/codecast/.git/cast-line/line-ct-57659/reps.json)\n\npass  wrote /Users/ashot/src/codecast/.git/cast-line/line-ct-57659/eval-result.json",
   "started_at": 1791396470402,
   "status": "completed"
  },
  {
   "completed_at": 1791396651398,
   "node_id": "review",
   "outcome": "success",
   "session_id": "jx7f111",
   "started_at": 1791396473943,
   "status": "completed"
  }
 ],
 "created_at": 1791395404888,
 "updated_at": 1791397008892
};

export const ct57659Run5: ReportRun = {
 "_id": "th71cxvr5c2fxhjqkq13f6fe418fvyt5",
 "status": "paused",
 "current_node_id": "decide",
 "task_short_id": "ct-57659",
 "workflow_name": "line",
 "node_statuses": [
  {
   "completed_at": 1791397459315,
   "node_id": "start",
   "outcome": "success",
   "started_at": 1791397459119,
   "status": "completed"
  },
  {
   "completed_at": 1791397481191,
   "node_id": "ground",
   "outcome": "success",
   "session_id": "jx752y5",
   "started_at": 1791397460030,
   "status": "completed"
  },
  {
   "completed_at": 1791397524615,
   "node_id": "analyze",
   "outcome": "success",
   "session_id": "jx77tqg",
   "started_at": 1791397482372,
   "status": "completed"
  },
  {
   "completed_at": 1791397599150,
   "node_id": "prove_line",
   "outcome": "success",
   "session_id": "jx7efmc",
   "started_at": 1791397526228,
   "status": "completed"
  },
  {
   "completed_at": 1791397601508,
   "node_id": "red",
   "outcome": "success",
   "result_preview": "{\"red\": true, \"dir\": \"/Users/ashot/src/codecast/.git/cast-line/line-ct-57659\", \"why\": \"repro.sh fails\"}",
   "started_at": 1791397599615,
   "status": "completed"
  },
  {
   "completed_at": 1791398216492,
   "node_id": "implement_line",
   "outcome": "success",
   "session_id": "jx73nxx",
   "started_at": 1791398010219,
   "status": "completed"
  },
  {
   "completed_at": 1791398218190,
   "node_id": "verify",
   "outcome": "success",
   "result_preview": "no verify command configured in .codecast/workspace.toml ([verify] command = \"...\"); nothing to run",
   "started_at": 1791398216929,
   "status": "completed"
  },
  {
   "completed_at": 1791398219407,
   "node_id": "green",
   "outcome": "success",
   "result_preview": "bun test v1.3.14 (0d9b296a)\n\npackages/cli/src/workflow/proveFailRoute.test.ts:\n(pass) a failed Prove has a route > analyze leads to prove [0.04ms]\n(pass) a failed Prove has a route > prove (category code, failed, no proof json) parks at unproven [0.45ms]\n(pass) a failed Prove has a route > prove (category code, settled, no proof json) parks at unproven [0.04ms]\n(pass) a failed Prove has a route > prove (category code, reproduced missing) parks at unproven [0.09ms]\n(pass) a failed Prove has a route > prove (category code, reproduced unusable) parks at unproven [0.04ms]\n(pass) a failed Prove has a route > prove (category code, reproduced null) parks at unproven [0.06ms]\n(pass) a failed Prove has a route > prove (category code, proof json unreadable) parks at unproven [0.07ms]\n(pass) a failed",
   "started_at": 1791398218607,
   "status": "completed"
  },
  {
   "completed_at": 1791398221269,
   "node_id": "eval",
   "outcome": "success",
   "result_preview": "no surface's sources differ from main; nothing to run\n\npass  $0.00  wrote /Users/ashot/src/codecast/.git/cast-line/line-ct-57659/eval-result.json (reps /Users/ashot/src/codecast/.git/cast-line/line-ct-57659/reps.json)\n\npass  wrote /Users/ashot/src/codecast/.git/cast-line/line-ct-57659/eval-result.json",
   "started_at": 1791398220041,
   "status": "completed"
  },
  {
   "completed_at": 1791398419122,
   "node_id": "review",
   "outcome": "success",
   "session_id": "jx7cezh",
   "started_at": 1791398222271,
   "status": "completed"
  },
  {
   "completed_at": 1791398421328,
   "node_id": "card_draft",
   "outcome": "success",
   "result_preview": "{\n  \"card\": {\n    \"cause\": {\n      \"task\": \"ct-57659\",\n      \"title\": \"When Prove fails outright (it could not write a test, so there is no prove.json), the run stops with \\\"the line had no...\",\n      \"signals\": 1,\n      \"first_seen\": 1791335829444,\n      \"sources\": [\n        \"person\"\n      ]\n    },\n    \"goal\": {\n      \"ref\": \"line\",\n      \"name\": \"The line\",\n      \"why\": \"the line doing its job: fewer expectation breaks a day, most new signals joining a cause it already knows, the fixes it ships holding, and every station working\"\n    },\n    \"wrong\": \"\",\n    \"change\": \"\",\n    \"proof\": {\n      \"before\": [\n        {\n          \"name\": \"The shipped line routes a failed Prove (no prove.json) to some station instead of a dead end\",\n          \"ok\": false,\n          \"detail\": \" failed, no outgoin",
   "started_at": 1791398419906,
   "status": "completed"
  },
  {
   "completed_at": 1791398444258,
   "node_id": "card_write",
   "outcome": "success",
   "session_id": "jx76k0q",
   "started_at": 1791398422138,
   "status": "completed"
  },
  {
   "completed_at": 1791398456549,
   "node_id": "card",
   "outcome": "success",
   "result_preview": "* Change card: When Prove fails outright (it could not write a test, so there is no prove.json), the run stops with \"the line had no...  v1 -> published\n  https://codecast.sh/a/p0SbB2LDqKU7\n  evidence: attached to ct-57659 at in_review\n  manage (owner link — keep private): https://codecast.sh/a/p0SbB2LDqKU7#o=QtJf1xwsc4U6Aa7SCb6x\ncard: /Users/ashot/src/codecast/.git/cast-line/line-ct-57659/card.json\npage: /Users/ashot/src/codecast/.git/cast-line/line-ct-57659/card.html\n  1 of 1 case fixed · 4 checks pass · 0 examples",
   "started_at": 1791398444743,
   "status": "completed"
  },
  {
   "node_id": "decide",
   "started_at": 1791398457036,
   "status": "running"
  }
 ],
 "created_at": 1791397456668,
 "updated_at": 1791398457211,
 "gate_node_id": "decide",
 "gate_choices": [
  {
   "key": "S",
   "label": "[S] Ship",
   "target": "rebase"
  },
  {
   "key": "R",
   "label": "[R] Revise",
   "target": "reopen"
  },
  {
   "key": "D",
   "label": "[D] Drop",
   "target": "drop"
  }
 ],
 "gate_decision_short_id": "sd-501",
 "gate_decision_status": "pending"
};
