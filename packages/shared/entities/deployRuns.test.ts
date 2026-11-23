import { describe, expect, test } from "bun:test";
import { deployRunRefRegex, parseDeployRunRef, splitDeployRunRef } from "./index";

const matches = (text: string) => [...text.matchAll(deployRunRefRegex())].map((m) => ({ lead: m[1], id: m[2] }));

describe("a GitHub Actions run named by its bare id", () => {
  test("after deploy, deploy run or run, any case, with or without #", () => {
    expect(matches("Deploy 44822506482 is in progress")).toEqual([{ lead: "Deploy ", id: "44822506482" }]);
    expect(matches("the deploy run 44840113651 failed")).toEqual([{ lead: "deploy run ", id: "44840113651" }]);
    expect(matches("(run 44825521157)")).toEqual([{ lead: "run ", id: "44825521157" }]);
    expect(matches("Run #448255211 and deploy #448255212")).toEqual([
      { lead: "Run #", id: "448255211" },
      { lead: "deploy #", id: "448255212" },
    ]);
  });

  test("never a number under nine digits, one after another word, or one glued to more", () => {
    expect(matches("Deploy 12345678 is a count")).toEqual([]);
    expect(matches("Order 44822506482 shipped")).toEqual([]);
    expect(matches("rerun 44822506482")).toEqual([]);
    expect(matches("run 44822506482abc")).toEqual([]);
  });

  test("the words in front stay prose, the id keeps the # it was written with", () => {
    expect(splitDeployRunRef("Deploy ", "44822506482")).toEqual({ text: "Deploy ", payload: "deployrun:44822506482|44822506482" });
    expect(splitDeployRunRef("run #", "44822506482")).toEqual({ text: "run ", payload: "deployrun:44822506482|#44822506482" });
  });

  test("the payload reads back, and nothing else does", () => {
    expect(parseDeployRunRef("deployrun:44822506482|#44822506482")).toEqual({ id: "44822506482", label: "#44822506482" });
    expect(parseDeployRunRef("deployrun:1234|1234")).toBeNull();
    expect(parseDeployRunRef("pr:#12|#12")).toBeNull();
    expect(parseDeployRunRef(null)).toBeNull();
  });
});
