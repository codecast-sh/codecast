// `cast dev` and the project's [vault]: a read Ask first holds stops before any server starts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NEEDS_APPROVAL_EXIT } from "../secrets/approval.js";
import { vaultEnv } from "./devCli.js";

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realError = console.error;
const realConfigDir = process.env.CODECAST_DIR;
let errors: string[];

beforeEach(() => {
  errors = [];
  console.error = (line: string) => void errors.push(line);
  process.exit = ((code: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
  process.env.CODECAST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dev-vault-"));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exit = realExit;
  console.error = realError;
  if (realConfigDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = realConfigDir;
});

const deps = { getCliEndpoint: () => ({ siteUrl: "https://backend.test", apiToken: "t" }), detectCurrentSessionId: () => "jx7abc" };

test("an Ask first hold on an optional [vault] line stops cast dev with the decision, instead of starting without the secrets", async () => {
  const held = { needs_approval: { decision: "sd-9", secret: "staging-db" }, approvals: [{ decision: "sd-9", secret: "staging-db" }], message: "m" };
  globalThis.fetch = (async (url: string) =>
    Response.json(new URL(url).pathname === "/cli/vault/list" ? [{ name: "staging-db", kind: "key", status: "ready", short_id: "sec-3" }] : held)) as unknown as typeof fetch;
  const said: string[] = [];
  const env = vaultEnv(deps, { DATABASE_URL: { secret: "staging-db", required: false } }, (l) => said.push(l))!;
  await expect(env()).rejects.toThrow(`exit ${NEEDS_APPROVAL_EXIT}`);
  expect(errors.join("\n")).toContain("sd-9");
  expect(said).toEqual([]);
});
