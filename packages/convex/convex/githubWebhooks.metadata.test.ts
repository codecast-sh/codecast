// Labels, assignees and dismissed reviews arrive on the same payloads the
// pull request has always sent; the row keeps them as GitHub states them.
import { describe, expect, test } from "bun:test";
import { mapReviewState, prMetadataFrom } from "./githubWebhooks";

describe("pull request metadata from a payload", () => {
  test("labels keep their colour and assignees are logins", () => {
    expect(prMetadataFrom({
      labels: [{ name: "bug", color: "d73a4a" }, { name: "needs review" }, { nope: true }],
      assignees: [{ login: "ashot" }, { login: "sam" }, {}],
    })).toEqual({
      labels: [{ name: "bug", color: "d73a4a" }, { name: "needs review", color: undefined }],
      assignees: ["ashot", "sam"],
    });
  });

  test("a payload without either answers empty lists, not undefined", () => {
    expect(prMetadataFrom({})).toEqual({ labels: [], assignees: [] });
  });
});

describe("review states", () => {
  test("a dismissed review stays dismissed instead of posing as a comment", () => {
    expect(mapReviewState("dismissed")).toBe("dismissed");
    expect(mapReviewState("DISMISSED")).toBe("dismissed");
    expect(mapReviewState("approved")).toBe("approved");
    expect(mapReviewState(undefined)).toBe("commented");
  });
});
