import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adminCheckout, cliIdentity, devSessionHandler, refusal } from "./devSignIn";

const PROD = "https://convex.codecast.sh";
const ok = { method: "POST", peer: "127.0.0.1", headers: { host: "localhost:3207", "sec-fetch-site": "same-origin" } };

describe("refusal", () => {
  test("a same-origin page on this machine may take a session", () => {
    expect(refusal(ok, [])).toBeNull();
    expect(refusal({ ...ok, headers: { host: "local.1.codecast.sh" } }, ["local.1.codecast.sh"])).toBeNull();
  });
  test("a local client with no browser fetch metadata may take one", () => {
    expect(refusal({ ...ok, headers: { host: "127.0.0.1:3201" } }, [])).toBeNull();
  });
  test("a cross-site page may not", () => {
    expect(refusal({ ...ok, headers: { ...ok.headers, "sec-fetch-site": "cross-site" } }, [])).toContain("cross-site");
    expect(refusal({ ...ok, headers: { ...ok.headers, "sec-fetch-site": "same-site" } }, [])).toContain("same-site");
  });
  test("a peer on the LAN may not", () => {
    expect(refusal({ ...ok, peer: "192.168.1.20" }, [])).toBe("not from this machine");
  });
  test("a rebound hostname may not", () => {
    expect(refusal({ ...ok, headers: { ...ok.headers, host: "evil.example:3207" } }, [])).toContain("evil.example");
  });
  test("GET is refused, so a link or an img cannot mint", () => {
    expect(refusal({ ...ok, method: "GET" }, [])).toBe("POST only");
  });
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dev-sign-in-"));
}
function checkout(root: string, env: string): void {
  fs.mkdirSync(path.join(root, "packages", "convex"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "convex", ".env.local"), env);
  fs.writeFileSync(path.join(root, "packages", "convex", "run.sh"), "");
}

describe("adminCheckout", () => {
  test("this checkout when it holds the key for the web's deployment", () => {
    const root = tmp();
    checkout(root, `CONVEX_SELF_HOSTED_URL=${PROD}\nCONVEX_SELF_HOSTED_ADMIN_KEY=k\n`);
    expect(adminCheckout(root, PROD, null)).toBe(root);
  });
  test("the main checkout behind a worktree that has no env", () => {
    const main = tmp();
    checkout(main, `CONVEX_SELF_HOSTED_URL=${PROD}\nCONVEX_SELF_HOSTED_ADMIN_KEY=k\n`);
    expect(adminCheckout(tmp(), PROD, path.join(main, ".git"))).toBe(main);
  });
  test("none when the key is for another deployment, or missing", () => {
    const other = tmp();
    checkout(other, "CONVEX_SELF_HOSTED_URL=https://elsewhere\nCONVEX_SELF_HOSTED_ADMIN_KEY=k\n");
    expect(adminCheckout(other, PROD, null)).toBeNull();
    const keyless = tmp();
    checkout(keyless, `CONVEX_SELF_HOSTED_URL=${PROD}\n`);
    expect(adminCheckout(keyless, PROD, null)).toBeNull();
  });
});

test("cliIdentity reads the user the CLI is signed in as", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ user_id: "u1" }));
  expect(cliIdentity(dir)).toEqual({ userId: "u1", convexUrl: PROD });
  expect(cliIdentity(tmp())).toBeNull();
});

describe("devSessionHandler", () => {
  function call(handler: ReturnType<typeof devSessionHandler>, req = ok) {
    let status = 0;
    let body = "";
    const res = { statusCode: 0, setHeader() {}, end(b: string) { status = this.statusCode; body = b; } };
    const incoming = { method: req.method, headers: req.headers, socket: { remoteAddress: req.peer } };
    return handler(incoming as never, res as never).then(() => ({ status, body: JSON.parse(body) }));
  }
  const minted = { token: "jwt", refreshToken: "ref", user: { _id: "u1" } };

  test("mints once for tabs that ask together", async () => {
    let mints = 0;
    const handler = devSessionHandler(() => PROD, () => [], {
      identity: () => ({ userId: "u1", convexUrl: PROD }),
      checkout: () => "/repo",
      mint: async (root, userId) => {
        mints++;
        expect([root, userId]).toEqual(["/repo", "u1"]);
        return minted;
      },
    });
    const [a, b] = await Promise.all([call(handler), call(handler)]);
    expect(a).toEqual({ status: 200, body: { token: "jwt", refreshToken: "ref", user: "u1" } });
    expect(b.status).toBe(200);
    expect(mints).toBe(1);
  });

  test("never mints for a dev server pointed at another deployment", async () => {
    const handler = devSessionHandler(() => "http://127.0.0.1:3210", () => [], {
      identity: () => ({ userId: "u1", convexUrl: PROD }),
      checkout: () => "/repo",
      mint: async () => { throw new Error("must not mint"); },
    });
    const r = await call(handler);
    expect(r.status).toBe(503);
    expect(r.body.error).toContain("signed in to");
  });

  test("a machine without the admin key is told why", async () => {
    const handler = devSessionHandler(() => PROD, () => [], {
      identity: () => ({ userId: "u1", convexUrl: PROD }),
      checkout: () => null,
      mint: async () => minted,
    });
    expect((await call(handler)).body.error).toContain("no admin key");
  });

  test("a refused request never reaches the mint", async () => {
    const handler = devSessionHandler(() => PROD, () => [], {
      identity: () => { throw new Error("must not read identity"); },
      checkout: () => "/repo",
      mint: async () => minted,
    });
    expect((await call(handler, { ...ok, peer: "10.0.0.5" })).status).toBe(403);
  });
});
