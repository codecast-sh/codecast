import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { looksLikeToken, redactHar, redactHarFile, Redactor, redactSnapshotValues } from "./redaction.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl";

describe("Redactor headers", () => {
  test("authorization keeps its scheme, the credential goes", () => {
    const r = new Redactor();
    expect(r.header("Authorization", `Bearer ${JWT}`)).toBe("Bearer [REDACTED_1]");
    expect(r.header("proxy-authorization", "Basic dXNlcjpwYXNz")).toBe("Basic [REDACTED_2]");
  });

  test("cookie values go, names and set-cookie attributes stay", () => {
    const r = new Redactor();
    expect(r.header("Cookie", "sid=abc123; theme=dark")).toBe("sid=[REDACTED_1]; theme=[REDACTED_2]");
    expect(r.header("set-cookie", "sid=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=60")).toBe(
      "sid=[REDACTED_1]; Path=/; HttpOnly; SameSite=Lax; Max-Age=60",
    );
  });

  test("csrf, api key and token-named headers go; ordinary headers stay", () => {
    const r = new Redactor();
    expect(r.header("X-CSRF-Token", "t1")).toBe("[REDACTED_1]");
    expect(r.header("x-api-key", "k1")).toBe("[REDACTED_2]");
    expect(r.header("X-Session-Id", "s1")).toBe("[REDACTED_3]");
    expect(r.header("Content-Type", "application/json")).toBe("application/json");
    expect(r.header("Accept-Language", "en")).toBe("en");
  });

  test("the same value gets the same placeholder everywhere", () => {
    const r = new Redactor();
    const a = r.header("Authorization", `Bearer ${JWT}`);
    const b = r.header("x-auth-token", JWT);
    expect(a.split(" ")[1]).toBe(b);
  });
});

describe("Redactor URLs and bodies", () => {
  test("query and fragment fields by name; untouched pairs keep their encoding", () => {
    const r = new Redactor();
    expect(r.url("https://a.test/cb?code=xyz&state=ok&q=a%20b#access_token=tok&x=1")).toBe(
      "https://a.test/cb?code=[REDACTED_1]&state=ok&q=a%20b#access_token=[REDACTED_2]&x=1",
    );
  });

  test("token-like path segments go, slugs and uuids stay", () => {
    const r = new Redactor();
    expect(r.url(`https://a.test/reset/${JWT}/confirm`)).toBe("https://a.test/reset/[REDACTED_1]/confirm");
    expect(r.url("https://a.test/how-to-install-the-browser-extension")).toBe("https://a.test/how-to-install-the-browser-extension");
    expect(r.url("https://a.test/item/123e4567-e89b-12d3-a456-426614174000")).toContain("123e4567");
    expect(looksLikeToken("a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe(true);
  });

  test("form, JSON and multipart bodies by field name, password and OTP included", () => {
    const r = new Redactor();
    expect(r.body("email=a%40b.test&password=hunter2&otp=123456", "application/x-www-form-urlencoded")).toBe(
      "email=a%40b.test&password=[REDACTED_1]&otp=[REDACTED_2]",
    );
    expect(JSON.parse(r.body(JSON.stringify({ user: "ada", auth: { pin: 4321, remember: true } }), "application/json"))).toEqual({
      user: "ada",
      auth: { pin: "[REDACTED_3]", remember: true },
    });
    const mp = '--B\r\nContent-Disposition: form-data; name="user"\r\n\r\nada\r\n--B\r\nContent-Disposition: form-data; name="passcode"\r\n\r\nsecret9\r\n--B--\r\n';
    expect(r.body(mp, "multipart/form-data; boundary=B")).toBe(mp.replace("secret9", "[REDACTED_4]"));
  });
});

describe("redactHar", () => {
  const har = () => ({
    log: {
      version: "1.2",
      entries: [
        {
          request: {
            method: "POST",
            url: "https://a.test/login",
            headers: [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }, { name: "Cookie", value: "pre=v1abcdef" }],
            cookies: [{ name: "pre", value: "v1abcdef" }],
            queryString: [],
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              text: "email=ada%40a.test&password=correct-horse",
              params: [{ name: "email", value: "ada@a.test" }, { name: "password", value: "correct-horse" }],
            },
          },
          response: {
            status: 200,
            headers: [{ name: "Set-Cookie", value: "sid=SESS1234567; Path=/; HttpOnly" }],
            cookies: [{ name: "sid", value: "SESS1234567" }],
            redirectURL: "",
            content: { mimeType: "application/json", text: JSON.stringify({ access_token: "tok_ABCDEFG", user: "ada" }) },
          },
        },
        {
          request: {
            method: "GET",
            // The token echoed under a name that does not look secret.
            url: "https://a.test/api/me?t=tok_ABCDEFG",
            headers: [{ name: "Authorization", value: "Bearer tok_ABCDEFG" }],
            queryString: [{ name: "t", value: "tok_ABCDEFG" }],
          },
          response: {
            status: 200,
            headers: [],
            content: { mimeType: "text/html", text: "<p>your session is SESS1234567</p>" },
          },
        },
      ],
    },
  });

  test("no secret survives anywhere in the file, and placeholders correlate", () => {
    const h = har();
    const n = redactHar(h);
    const text = JSON.stringify(h);
    for (const secret of ["correct-horse", "SESS1234567", "tok_ABCDEFG", "v1abcdef"]) expect(text).not.toContain(secret);
    expect(n).toBeGreaterThanOrEqual(4);
    const e = h.log.entries;
    const tok = JSON.parse(e[0].response.content.text).access_token;
    expect(e[1].request.headers[0].value).toBe(`Bearer ${tok}`);
    expect(e[1].request.url).toBe(`https://a.test/api/me?t=${tok}`);
    // Non-secret values stay readable.
    expect(text).toContain("ada@a.test");
    expect(e[0].request.postData!.params![0].value).toBe("ada@a.test");
  });

  test("a file round trip rewrites in place; a non-HAR file is left alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-har-"));
    try {
      const file = path.join(dir, "x.har");
      fs.writeFileSync(file, JSON.stringify(har()));
      expect(redactHarFile(file, fs)).toBeGreaterThan(0);
      expect(fs.readFileSync(file, "utf-8")).not.toContain("correct-horse");
      const other = path.join(dir, "y.har");
      fs.writeFileSync(other, "not json");
      expect(redactHarFile(other, fs)).toBeNull();
      expect(fs.readFileSync(other, "utf-8")).toBe("not json");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("redactSnapshotValues", () => {
  test("password and code values leave every place they appear; other text stays", () => {
    const text = '- textbox "Email" [ref=e1]: ada@a.test\n- textbox "Password" [ref=e2]: hunter2secret\n- textbox "Code" value="123456" #e3';
    const out = redactSnapshotValues(text, ["hunter2secret", "123456"]);
    expect(out).not.toContain("hunter2secret");
    expect(out).not.toContain("123456");
    expect(out).toContain("ada@a.test");
    expect(out).toContain('"Password" [ref=e2]: [hidden]');
  });

  test("a short value is replaced only where it stands as a value", () => {
    const out = redactSnapshotValues('- heading "Step 1"\n- textbox "PIN" value="7"', ["7", "1"]);
    expect(out).toBe('- heading "Step 1"\n- textbox "PIN" value="[hidden]"');
  });

  test("Chrome's bullet mask is collapsed so it does not leak the length", () => {
    expect(redactSnapshotValues('- textbox "Password": ••••••••', [])).toBe('- textbox "Password": [hidden]');
  });
});
