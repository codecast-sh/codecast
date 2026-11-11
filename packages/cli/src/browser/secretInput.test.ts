import { describe, expect, test } from "bun:test";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";
import type { ReadSecret } from "../secrets/inject.js";
import { parseTypeArgs, parseVaultSpec, stdinValue, typeSecretInput, type SecretInput } from "./secretInput.js";
import type { FocusProbe, SecretTypeDeps, SecretTypePage } from "./secretType.js";

const PASSWORD = "correct-horse-battery";

describe("parseTypeArgs", () => {
  test("plain text passes through unchanged, --submit and the shot flags included", () => {
    expect(parseTypeArgs("fill", ["#e3", "hello", "--submit", "--no-shot"])).toEqual({ mode: "text", args: ["#e3", "hello", "--submit", "--no-shot"] });
    // A single dash is text: a negative number, a dash in a search box.
    expect(parseTypeArgs("type", ["#e3", "-5"])).toEqual({ mode: "text", args: ["#e3", "-5"] });
  });

  test("an unknown flag is an error, never text the engine would type", () => {
    for (const flag of ["--stdn", "--password", "--clear", "--value=x"]) {
      const r = parseTypeArgs("fill", ["#e3", flag]);
      expect("error" in r && r.error).toBe(`fill does not take ${flag.split("=")[0]}`);
    }
  });

  test("text that starts with -- goes after a bare --", () => {
    expect(parseTypeArgs("type", ["#e3", "--", "--stdin"])).toEqual({ mode: "text", args: ["#e3", "--", "--stdin"] });
  });

  test("--vault takes the entry and an optional field, in either spelling", () => {
    expect(parseTypeArgs("fill", ["#e3", "--vault", "nyp-connect"])).toMatchObject({ mode: "vault", target: "#e3", name: "nyp-connect", field: undefined });
    expect(parseTypeArgs("fill", ["#e2", "--vault=nyp-connect/username", "--submit"])).toMatchObject({ mode: "vault", name: "nyp-connect", field: "username", submit: true });
    expect(parseTypeArgs("fill", ["--vault", "x/otp", "#e9", "--no-shot"])).toMatchObject({ target: "#e9", field: "otp", stepFlags: ["--no-shot"] });
  });

  test("--stdin needs only the target", () => {
    expect(parseTypeArgs("type", ["input[name=pw]", "--stdin"])).toMatchObject({ mode: "stdin", target: "input[name=pw]" });
  });

  test("a secret source refuses a text argument beside it, both sources at once, and a missing name", () => {
    expect(parseTypeArgs("fill", ["#e3", "hunter2", "--vault", "x"])).toMatchObject({ error: expect.stringContaining("only the target") });
    expect(parseTypeArgs("fill", ["#e3", "--vault", "x", "--stdin"])).toMatchObject({ error: "fill takes --vault or --stdin, not both" });
    expect(parseTypeArgs("fill", ["#e3", "--vault"])).toMatchObject({ error: expect.stringContaining("needs a secret name") });
    expect(parseTypeArgs("fill", ["#e3", "--vault", "--submit"])).toMatchObject({ error: expect.stringContaining("needs a secret name") });
  });

  test("a bare --vault after find acts on what find matched; with neither it asks for a target", () => {
    expect(parseTypeArgs("fill", ["--vault", "x"], "@e7")).toMatchObject({ target: "@e7" });
    expect(parseTypeArgs("fill", ["--vault", "x"])).toMatchObject({ error: "fill --vault needs a target" });
  });
});

describe("parseVaultSpec", () => {
  test("names the field after the slash, or refuses one it does not know", () => {
    expect(parseVaultSpec("acme")).toEqual({ name: "acme", field: undefined });
    expect(parseVaultSpec("acme/password")).toEqual({ name: "acme", field: "password" });
    expect(parseVaultSpec("acme/pin")).toMatchObject({ error: expect.stringContaining("username") });
    expect(parseVaultSpec("/username")).toMatchObject({ error: expect.stringContaining("needs a secret name") });
  });
});

describe("stdinValue", () => {
  test("drops the one trailing newline a pipe adds, keeps the rest", () => {
    expect(stdinValue(() => ` ${PASSWORD} \n`)).toBe(` ${PASSWORD} `);
    expect(stdinValue(() => `${PASSWORD}\r\n`)).toBe(PASSWORD);
  });
  test("an empty pipe types nothing", () => {
    expect(() => stdinValue(() => "\n")).toThrow(/stdin was empty/);
  });
});

/** A page whose field is on the secret's site; records what was inserted. */
function fakePage(url = "https://myconnect.nyp.org/login", probe: Partial<FocusProbe> = {}) {
  const inserted: string[] = [];
  let selected = 0;
  const page: SecretTypePage = {
    topUrl: async () => url,
    focus: async () => {},
    probe: async () => ({ frame: "top", editable: true, docOrigin: new URL(url).origin, key: "k", ...probe }),
    selectAll: async () => void selected++,
    insertText: async (t) => void inserted.push(t),
  };
  return { page, inserted, selected: () => selected };
}

const vault: Pick<SecretTypeDeps, "meta" | "read"> = {
  meta: async (n) =>
    n === "nyp-connect"
      ? ({ _id: "s", short_id: "sc-1", name: n, kind: "login", status: "ready", workspace: "team:t", sites: ["myconnect.nyp.org"], created_by: "u", created_at: 0, updated_at: 0 } as SecretMeta)
      : null,
  read: async (n): Promise<ReadSecret> => ({ id: "s", short_id: "sc-1", name: n, kind: "login", sites: ["myconnect.nyp.org"], payload: { username: "ashot.p", password: PASSWORD } }),
};

const input = (over: Partial<SecretInput>): SecretInput => ({ mode: "vault", target: "#e3", name: "nyp-connect", submit: false, json: false, stepFlags: [], ...over });

describe("typeSecretInput", () => {
  test("fill --vault types the password and reports only the name, field and origin", async () => {
    const f = fakePage();
    for (const json of [false, true]) {
      const line = await typeSecretInput("fill", input({ json }), { page: f.page, vault, policy: null });
      expect(line).not.toContain(PASSWORD);
      expect(line).toContain("nyp-connect");
    }
    expect(JSON.parse(await typeSecretInput("fill", input({ json: true }), { page: f.page, vault, policy: null }))).toEqual({
      typed: true, name: "nyp-connect", origin: "https://myconnect.nyp.org", field: "password",
    });
    expect(f.inserted).toEqual([PASSWORD, PASSWORD, PASSWORD]);
  });

  test("/username types the username", async () => {
    const f = fakePage();
    await typeSecretInput("fill", input({ field: "username" }), { page: f.page, vault, policy: null });
    expect(f.inserted).toEqual(["ashot.p"]);
  });

  test("a page off the secret's sites gets nothing", async () => {
    const f = fakePage("https://myconnect-nyp.example/login");
    await expect(typeSecretInput("fill", input({}), { page: f.page, vault, policy: null })).rejects.toThrow(/not a site of nyp-connect/);
    expect(f.inserted).toEqual([]);
  });

  test("--stdin types the piped value; fill replaces, type inserts at the caret; neither prints it", async () => {
    const f = fakePage("http://localhost:4100/");
    const fill = await typeSecretInput("fill", input({ mode: "stdin", name: undefined, json: true }), { page: f.page, vault, policy: null, text: PASSWORD });
    expect(JSON.parse(fill)).toEqual({ typed: true, source: "stdin", origin: "http://localhost:4100" });
    expect(f.selected()).toBe(1);
    const type = await typeSecretInput("type", input({ mode: "stdin", name: undefined }), { page: f.page, vault, policy: null, text: PASSWORD });
    expect(type).not.toContain(PASSWORD);
    expect(f.selected()).toBe(1);
    expect(f.inserted).toEqual([PASSWORD, PASSWORD]);
  });

  test("--stdin into something that is not a field types nothing", async () => {
    const f = fakePage("http://localhost:4100/", { editable: false });
    await expect(typeSecretInput("fill", input({ mode: "stdin" }), { page: f.page, vault, policy: null, text: PASSWORD })).rejects.toThrow(/not an editable text field/);
    expect(f.inserted).toEqual([]);
  });
});
