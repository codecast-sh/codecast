import { describe, expect, test } from "bun:test";
import { vaultRedactionSource } from "./redactionSource.js";

const SITE = "https://backend.test";

/** A fake backend: answers the two redaction routes and counts calls to each. */
function backend(state: { version: string; values: Array<{ name: string; value: string }>; status?: number; down?: boolean }) {
  const calls = { version: 0, values: 0 };
  const fetch = (async (url: string) => {
    if (state.down) throw new TypeError("fetch failed");
    const route = url.slice(SITE.length);
    const status = state.status ?? 200;
    if (route === "/cli/vault/redaction-version") {
      calls.version++;
      return Response.json(status === 200 ? { version: state.version } : { error: "Unauthorized: sign in" }, { status });
    }
    if (route === "/cli/vault/redaction-values") {
      calls.values++;
      return Response.json({ version: state.version, values: state.values });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function source(state: Parameters<typeof backend>[0]) {
  const { calls, fetch } = backend(state);
  const logs: string[] = [];
  const src = vaultRedactionSource({ endpoint: () => ({ siteUrl: SITE, apiToken: "tok" }), log: (l) => logs.push(l), fetch });
  return { src, calls, logs };
}

describe("vault redaction source", () => {
  test("fetches values on first poll, refetches only when the version moves", async () => {
    const state = { version: "team:a=1", values: [{ name: "stripe", value: "sk_vault_9f8e7d6c5b4a" }] };
    const { src, calls } = source(state);

    expect(await src.refresh()).toBe(true);
    expect(src.values()).toEqual([{ name: "stripe", value: "sk_vault_9f8e7d6c5b4a" }]);
    expect(calls).toEqual({ version: 1, values: 1 });

    expect(await src.refresh()).toBe(false);
    expect(calls).toEqual({ version: 2, values: 1 });

    state.version = "team:a=2";
    state.values = [{ name: "stripe", value: "sk_vault_rotated_000111" }];
    expect(await src.refresh()).toBe(true);
    expect(calls).toEqual({ version: 3, values: 2 });
    expect(src.values().map((v) => v.value)).toEqual(["sk_vault_rotated_000111"]);
  });

  test("overlapping refreshes share one poll", async () => {
    const { src, calls } = source({ version: "v1", values: [] });
    await Promise.all([src.refresh(), src.refresh(), src.refresh()]);
    expect(calls).toEqual({ version: 1, values: 1 });
  });

  test("a network failure keeps the last good set; a refused token clears it", async () => {
    const state: Parameters<typeof backend>[0] = { version: "v1", values: [{ name: "db", value: "dbPassword-7731xyz" }] };
    const { src } = source(state);
    await src.refresh();

    state.down = true;
    expect(await src.refresh()).toBe(false);
    expect(src.values()).toHaveLength(1);

    state.down = false;
    state.status = 401;
    expect(await src.refresh()).toBe(true);
    expect(src.values()).toEqual([]);

    // Signed back in: the version is unknown again, so values are refetched.
    state.status = 200;
    expect(await src.refresh()).toBe(true);
    expect(src.values()).toHaveLength(1);
  });

  test("signed out clears the set", async () => {
    const { fetch } = backend({ version: "v1", values: [{ name: "db", value: "dbPassword-7731xyz" }] });
    let signedIn = true;
    const src = vaultRedactionSource({ endpoint: () => (signedIn ? { siteUrl: SITE, apiToken: "tok" } : null), fetch });
    await src.refresh();
    signedIn = false;
    expect(await src.refresh()).toBe(true);
    expect(src.values()).toEqual([]);
  });

  test("log lines name counts, never a value", async () => {
    const secret = "never-log-me-Qw7731xyz";
    const state: Parameters<typeof backend>[0] = { version: "v1", values: [{ name: "a", value: secret }, { name: "a", value: "second-Value-889900" }] };
    const { src, logs } = source(state);
    await src.refresh();
    state.down = true;
    await src.refresh();
    state.down = false;
    state.status = 403;
    await src.refresh();
    expect(logs[0]).toBe("[VAULT-REDACTION] 2 values from 1 secrets");
    expect(logs.length).toBe(3);
    for (const line of logs) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("second-Value-889900");
    }
  });
});
