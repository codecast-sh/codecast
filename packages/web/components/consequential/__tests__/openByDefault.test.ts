import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { DEFAULT_DAY_CAP, lineStartLedger } from "../lineStartLedger";
import { LINE_PROFILE_DEFAULTS } from "../../../../shared/contracts/lineProfile";
import { SUBAGENT_CAP_DEFAULTS } from "../../../../shared/contracts/subagentFleet";
import type { LineAdmission } from "../../../lib/lineFlow";

const CAPLESS: LineAdmission = { role: { id: "r1", handle: "callers", paused: false }, on: false, queued: 27, slots: 5, busy: 0, hands: 0, handsCap: null };

test("turning a line on with no daily cap picks No limit unless the person picks a number (CC-agents-6)", () => {
  assert.equal(DEFAULT_DAY_CAP, null);
  assert.equal(lineStartLedger({ project: "Callers", admission: CAPLESS, ready: 27, dayCap: DEFAULT_DAY_CAP }).pick?.value, "No limit");
});

test("a repo with no line profile has no open-card cap (CC-agents-6)", () => {
  const cards = (LINE_PROFILE_DEFAULTS as { caps?: { cards?: number } }).caps?.cards;
  assert.ok(cards === undefined || cards === 0, `caps.cards defaults to ${cards}`);
});

test("the CLI says subagents run without a default limit, as they do (CC-agents-6)", () => {
  assert.equal(SUBAGENT_CAP_DEFAULTS.per_machine, 0);
  const root = join(import.meta.dir, "../../../../cli/src");
  for (const f of ["index.ts", "config/types.ts"]) {
    const src = readFileSync(join(root, f), "utf8");
    assert.ok(!/subagents[\s\S]{0,200}?default 24/.test(src), `${f} still says subagents.per_machine defaults to 24`);
  }
});
