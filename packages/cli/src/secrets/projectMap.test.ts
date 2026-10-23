// A project's [vault]: finding it from inside a checkout, and naming every var it cannot fill.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envToSecret, planProjectRead, projectVault, varsBySecret, type VaultMap } from "./projectMap.js";

const map: VaultMap = {
  STRIPE_SECRET_KEY: { secret: "stripe-test", required: false },
  STRIPE_KEY_ALIAS: { secret: "stripe-test", required: false },
  DATABASE_URL: { secret: "staging-db", required: true },
  GH_TOKEN: { secret: "github-bot", required: false },
  SA_FILE: { secret: "gcp-sa", required: false },
  OPENAI_API_KEY: { secret: "openai", required: false },
};

const meta = (name: string, kind: "key" | "login" | "file" | "signin", status: "ready" | "requested" = "ready", short_id = "sec-9", workspace = "team:t1") => ({ name, kind, status, short_id, workspace });

describe("projectVault", () => {
  test("found from a subdirectory of the checkout, and not above the repo root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-project-"));
    try {
      const repo = path.join(root, "repo");
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      fs.mkdirSync(path.join(repo, "packages", "web"), { recursive: true });
      expect(projectVault(path.join(repo, "packages", "web"))).toBeNull();

      // A manifest above the repo root never applies to it.
      fs.mkdirSync(path.join(root, ".codecast"));
      fs.writeFileSync(path.join(root, ".codecast", "workspace.toml"), `[vault]\nX = "outer"\n`);
      expect(projectVault(path.join(repo, "packages", "web"))).toBeNull();

      fs.mkdirSync(path.join(repo, ".codecast"));
      fs.writeFileSync(path.join(repo, ".codecast", "workspace.toml"), `[vault]\nSTRIPE_SECRET_KEY = "stripe-test"\n`);
      expect(projectVault(path.join(repo, "packages", "web"))).toEqual({ STRIPE_SECRET_KEY: { secret: "stripe-test", required: false } });

      fs.writeFileSync(path.join(repo, ".codecast", "workspace.toml"), `[vault]\nSTRIPE_SECRET_KEY = "Stripe"\n`);
      expect(() => projectVault(repo)).toThrow("[vault] STRIPE_SECRET_KEY: the value is not a secret name");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty [vault] maps nothing", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vault-project-"));
    try {
      fs.mkdirSync(path.join(repo, ".codecast"));
      fs.writeFileSync(path.join(repo, ".codecast", "workspace.toml"), `[vault]\n`);
      expect(projectVault(repo)).toBeNull();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("shapes", () => {
  test("env var to secret, and the vars each secret fills", () => {
    expect(envToSecret(map).STRIPE_KEY_ALIAS).toBe("stripe-test");
    expect(varsBySecret(map).get("stripe-test")).toEqual(["STRIPE_SECRET_KEY", "STRIPE_KEY_ALIAS"]);
  });
});

describe("planProjectRead", () => {
  test("reads each ready secret once; every other var is a gap naming its fix", () => {
    const plan = planProjectRead(map, [
      meta("stripe-test", "key"),
      meta("staging-db", "key", "requested", "sec-4"),
      meta("github-bot", "login"),
      meta("gcp-sa", "file"),
    ]);
    expect(plan.read).toEqual(["stripe-test", "github-bot"]);
    expect(plan.gaps).toEqual([
      {
        envVar: "DATABASE_URL",
        secret: "staging-db",
        required: true,
        line: "DATABASE_URL: staging-db (sec-4) is requested and has no value yet. Fill it on the Vault page or with cast vault fill staging-db",
      },
      {
        envVar: "SA_FILE",
        secret: "gcp-sa",
        required: false,
        line: "SA_FILE: gcp-sa is a file secret; cast dev leaves it out, cast vault run puts it in a temp file",
      },
      {
        envVar: "OPENAI_API_KEY",
        secret: "openai",
        required: false,
        line: "OPENAI_API_KEY: no secret openai in your Vault. Ask for it: cast vault request openai --env OPENAI_API_KEY",
      },
    ]);
  });

  test("a name in a team and in personal is a gap unless the repo's workspace settles it, the way the read resolves it", () => {
    const both = [meta("stripe-test", "key", "ready", "sec-3", "user:u1"), meta("stripe-test", "key", "requested", "sec-4", "team:t1")];
    const map = { STRIPE_SECRET_KEY: { secret: "stripe-test", required: true } };
    const plain = planProjectRead(map, both);
    expect(plain.read).toEqual([]);
    expect(plain.gaps[0]!.line).toBe("STRIPE_SECRET_KEY: stripe-test is in 2 workspaces (sec-3 personal, sec-4 team): name the one you mean by its short id, like sec-3");
    // The team repo means the team's row, which is still a request: never the person's own key.
    expect(planProjectRead(map, both, "team:t1").gaps[0]!.line).toMatch(/sec-4\) is requested/);
    expect(planProjectRead(map, both, "user:u1").read).toEqual(["stripe-test"]);
  });

  test("a mapped sign-in fills nothing and says so", () => {
    const plan = planProjectRead({ SESSION: { secret: "vercel", required: false } }, [meta("vercel", "signin")]);
    expect(plan.read).toEqual([]);
    expect(plan.gaps[0]!.line).toBe("SESSION: vercel is a signin, which fills no env var");
  });
});
