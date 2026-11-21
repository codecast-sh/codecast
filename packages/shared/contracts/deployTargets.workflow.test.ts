import { describe, expect, test } from "bun:test";
import { DeployTargetError, parseDeployTargets, publishableTarget } from "./deployTargets";

// A target's deploy workflow (deploys.md DP11): `workflow = "deploy.yml"` names
// the GitHub Actions file its deploys run as. Synthetic data only.

const parse = (target: Record<string, unknown>) => parseDeployTargets({ target: [{ name: "web", runs: "push", ...target }] }, []);

describe("a [[target]]'s workflow", () => {
  test("a workflow file is read, a .github/workflows/ prefix and whitespace dropped", () => {
    expect(parse({ workflow: "deploy.yml" })[0]!.workflow).toBe("deploy.yml");
    expect(parse({ workflow: ".github/workflows/deploy.yaml" })[0]!.workflow).toBe("deploy.yaml");
    expect(parse({ workflow: "  release_web-2.yml " })[0]!.workflow).toBe("release_web-2.yml");
    expect(parse({})[0]!.workflow).toBeUndefined();
  });

  test("the server is sent the workflow", () => {
    expect(publishableTarget(parse({ workflow: "deploy.yml" })[0]!)).toMatchObject({ name: "web", workflow: "deploy.yml" });
  });

  test("a value that is not a workflow file is refused, naming the target", () => {
    for (const bad of ["deploy", "deploy.json", "workflows/deploy.yml", "../deploy.yml", ".github/workflows/", "", "  ", "deploy yml.yml"]) {
      let err: unknown = null;
      try {
        parse({ workflow: bad });
      } catch (e) {
        err = e;
      }
      expect([bad, err instanceof DeployTargetError]).toEqual([bad, true]);
      expect([bad, (err as Error).message]).toEqual([bad, expect.stringMatching(/^target\[0\]: target web: workflow ".*" is not a workflow file/)]);
    }
  });

  test("a workflow that is not a string is refused", () => {
    expect(() => parse({ workflow: 5 })).toThrow(/target\[0\]: 'workflow' must be a string/);
    expect(() => parse({ workflow: ["deploy.yml"] })).toThrow(DeployTargetError);
  });

  test("two targets naming one workflow are refused: a run of it is one deploy of one target", () => {
    const raw = { target: [
      { name: "web", runs: "push", when: ["web/**"], workflow: "deploy.yml" },
      { name: "api", runs: "push", when: ["api/**"], workflow: ".github/workflows/deploy.yml" },
    ] };
    expect(() => parseDeployTargets(raw, [])).toThrow(/target\[1\]: target api: workflow deploy.yml is already target web's/);
  });
});
