import { describe, expect, test } from "bun:test";
import { plainTitle } from "../plainTitle";

describe("plainTitle", () => {
  test("drops a commit hash with the word that pointed at it", () => {
    expect(plainTitle("Main CI red at ac5c98b: networkMutationAudit.test.ts fails")).toBe("Main CI red: networkMutationAudit.test.ts fails");
    expect(plainTitle("Call grader marked Anna down on Oussama Chamakhi call 0d7e2e4e for not pinning a follow-up time or a yes"))
      .toBe("Call grader marked Anna down on Oussama Chamakhi call for not pinning a follow-up time or a yes");
  });
  test("drops thread references and pasted problem refs", () => {
    expect(plainTitle("Samvit's ruling (#team thread 1791598261.885089, Oct 10 04:35Z): there is no real 'company need' category, so drop #3850's per-need classifier"))
      .toBe("Samvit's ruling: there is no real 'company need' category, so drop the per-need classifier");
    expect(plainTitle("Union's line is dropping finished fixes: approved changes get their Ship decision withdrawn (ct-57509, ct-57836, ct-57848)"))
      .toBe("Union's line is dropping finished fixes: approved changes get their Ship decision withdrawn");
    expect(plainTitle("Requested by Cameron (C0AQ2LDAV6J thread 1791568645.608059, Oct 9): feedback must say why")).toBe("Requested by Cameron: feedback must say why");
  });
  test("drops a commit-style lead and run ids", () => {
    expect(plainTitle("fix(web): held terminal screen on a stuck pending send")).toBe("Held terminal screen on a stuck pending send");
    expect(plainTitle("Ship exits 1 in run jx7d8avk2m9q0w4e5r6t7y8u1i")).toBe("Ship exits 1");
    expect(plainTitle("Contact d5858877-bc64-45b0-9a1e-0c2b3d4e5f60 got two openers")).toBe("Contact got two openers");
  });
  test("leaves ordinary titles alone", () => {
    for (const t of [
      "Banned callers still appear and can be assigned scheduled calls",
      "Call card summary shows only goal 1, hiding goals 2-3 from callers",
      "Funnel stages with no invariant: new cold replier to connected call (233 to 10 in 30d)",
      "Not met: An introduction email reaches both people and gives each what they need to act",
      "The post-call \"voice quality x/5\" figure averages in blank 0 readings",
      "Feedback cites the decade 2010 and accede as words",
    ]) expect(plainTitle(t)).toBe(t);
  });
  test("a title that is nothing but an id stays as it was", () => {
    expect(plainTitle("ct-123")).toBe("ct-123");
  });
});
