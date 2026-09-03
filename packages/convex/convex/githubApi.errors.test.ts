// What we show a person when GitHub refuses.
//
// GitHub puts the useful sentence in two different places, and the one that
// matters most to `cast pr review` is the buried one: approving your own pull
// request answers "Unprocessable Entity" at the top level, with the real
// reason inside errors[]. Showing the top-level message there tells the caller
// nothing about what they did wrong.
import { describe, expect, test } from "bun:test";
import { githubErrorMessage } from "./githubApi";
import { githubSentence } from "./prCli";

describe("GitHub's own words", () => {
  test("approving your own pull request says so", () => {
    const body = JSON.stringify({
      message: "Unprocessable Entity",
      errors: [
        {
          resource: "PullRequestReview",
          code: "custom",
          field: "user_id",
          message: "Can not approve your own pull request",
        },
      ],
      documentation_url: "https://docs.github.com/rest/pulls/reviews",
    });
    expect(githubErrorMessage(422, body)).toBe("Can not approve your own pull request");
  });

  test("a refusal GitHub has a rule for comes through as it is", () => {
    expect(githubErrorMessage(405, JSON.stringify({ message: "Pull Request is not mergeable" })))
      .toBe("Pull Request is not mergeable");
  });

  test("several complaints are all worth reading", () => {
    const body = JSON.stringify({
      message: "Validation Failed",
      errors: [{ message: "first thing" }, { message: "second thing" }],
    });
    expect(githubErrorMessage(422, body)).toBe("first thing; second thing");
  });

  test("an error given as a bare string still reads", () => {
    expect(githubErrorMessage(422, JSON.stringify({ message: "nope", errors: ["the reason"] })))
      .toBe("the reason");
  });

  // An errors[] entry without a message must not blank out the summary.
  test("empty details fall back to the summary", () => {
    const body = JSON.stringify({ message: "Not Found", errors: [{ code: "missing" }] });
    expect(githubErrorMessage(404, body)).toBe("Not Found");
  });

  test("a body that is not JSON is shown as it arrived", () => {
    expect(githubErrorMessage(502, "<html>bad gateway</html>")).toBe("502: <html>bad gateway</html>");
  });

  test("an empty body still says what happened", () => {
    expect(githubErrorMessage(500, "")).toBe("GitHub returned 500");
    expect(githubErrorMessage(403, JSON.stringify({}))).toBe("GitHub returned 403");
  });
});

// The other half of showing GitHub's words: an error thrown inside an action
// arrives at its caller wrapped in Convex's own reporting. `cast pr review`
// has to strip that back off, or a refusal reads as a crash.
describe("unwrapping an action's error", () => {
  test("the stack frame and the Uncaught prefix come off", () => {
    const wrapped = new Error(
      "Uncaught Error: Review Can not approve your own pull request\n    at handler (../convex/githubApi.ts:150:17)",
    );
    expect(githubSentence(wrapped)).toBe("Review Can not approve your own pull request");
  });

  test("a deployment tag and request id come off too", () => {
    const wrapped = new Error(
      "[CONVEX A(githubApi:submitPRReview)] [Request ID: abc123] Server Error\nUncaught Error: Pull Request is not mergeable\n    at handler (x.ts:1:1)",
    );
    expect(githubSentence(wrapped)).toBe("Pull Request is not mergeable");
  });

  test("a plain message is left alone", () => {
    expect(githubSentence(new Error("Pull Request is not mergeable"))).toBe("Pull Request is not mergeable");
  });

  test("something that is not an error still reads", () => {
    expect(githubSentence("just a string")).toBe("just a string");
  });

  // Never hand back an empty string: a blank error tells the caller nothing.
  test("a message that is only wrapping falls back to the raw text", () => {
    expect(githubSentence(new Error("Uncaught Error:"))).toBe("Uncaught Error:");
  });
});
