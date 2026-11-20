import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MESSAGING_POLICY,
  LOG_ENTRY_TYPES,
  MESSAGING_POLICIES,
  MESSAGING_POLICY_NAMES,
  isMessagingPolicyName,
  resolveMessagingPolicy,
} from "./messagingPolicy";
import { ORG_CONTEXT_GUIDANCE } from "./orgWhere";

const variant = (name: string) =>
  readFileSync(join(import.meta.dir, "../../evals/org-comms/suite/variants", `${name}.md`), "utf8").trim();

describe("messaging policies", () => {
  test("every name has its policy, under that name", () => {
    for (const name of MESSAGING_POLICY_NAMES) expect(MESSAGING_POLICIES[name].name).toBe(name);
  });

  test("lead is the default, and an unset or unknown name resolves to it", () => {
    expect(DEFAULT_MESSAGING_POLICY).toBe("lead");
    for (const name of [undefined, null, "", "peer", "LEAD"]) expect(resolveMessagingPolicy(name).name).toBe("lead");
    expect(resolveMessagingPolicy("shared-log").name).toBe("shared-log");
    expect(isMessagingPolicyName("shared-log")).toBe(true);
    expect(isMessagingPolicyName(3)).toBe(false);
  });

  test("lead is variant G4 word for word, delivered by the lead's feed", () => {
    expect(MESSAGING_POLICIES.lead.guidance).toBe(variant("G4"));
    expect(MESSAGING_POLICIES.lead.delivery).toBe("lead-feed");
    expect(ORG_CONTEXT_GUIDANCE.startsWith(`${variant("G4")}\n\n`)).toBe(true);
  });

  test("shared-log carries variant LOG and names the command for each entry type", () => {
    const log = MESSAGING_POLICIES["shared-log"];
    expect(log.delivery).toBe("plan-log");
    for (const line of [
      "Each agent reads only the entries that are new to it. Read the new entries before you act.",
      "A fact is a finding that a teammate can use, with its evidence.",
      "A fail is an approach that did not work, with the reason, so that nobody tries it again.",
      "An interface is a contract that the work of another agent depends on.",
      "Leave out progress, plans and findings that matter only to you. Keep messages for what must change the next action of one agent now.",
    ]) expect(log.guidance).toContain(line);
    expect(log.guidance).toContain(`--type ${LOG_ENTRY_TYPES.join("|")}`);
  });
});
