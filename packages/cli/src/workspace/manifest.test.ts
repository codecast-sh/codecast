import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManifestError, parseManifest, parseManifestText } from "./manifest.js";

describe("parseManifest (filesystem)", () => {
  test("returns null when file does not exist", () => {
    expect(parseManifest("/tmp/__codecast_no_such_file__.toml")).toBeNull();
  });

  test("parses a real file on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-manifest-"));
    const p = path.join(dir, "workspace.toml");
    fs.writeFileSync(p, `[setup]\ninstall = ["bun install"]\n`);
    try {
      const m = parseManifest(p);
      expect(m).not.toBeNull();
      expect(m?.setup.install).toEqual(["bun install"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseManifestText — Manifest A (minimal)", () => {
  const toml = `[setup]\ninstall = ["bun install"]\n`;
  const m = parseManifestText(toml);

  test("install command parsed", () => {
    expect(m.setup.install).toEqual(["bun install"]);
  });

  test("missing sections default to empty", () => {
    expect(m.setup.copy).toEqual([]);
    expect(m.setup.generate).toEqual([]);
    expect(m.setup.migrate).toEqual([]);
    expect(m.ports).toEqual({});
    expect(m.services).toEqual({});
    expect(m.env).toEqual({});
    expect(m.teardown.run).toEqual([]);
  });
});

describe("parseManifestText — Manifest B (typical codecast-like)", () => {
  const toml = `
[setup]
copy = [".env", ".env.local"]
install = ["bun install"]
generate = ["bun run codegen"]
migrate = ["bun run db:migrate"]

[ports.web]
base = 3000
range = 100

[ports.convex]
base = 3210
range = 100

[env]
NODE_ENV = "development"

[teardown]
run = ["bun run db:reset"]
`;
  const m = parseManifestText(toml);

  test("setup commands parsed", () => {
    expect(m.setup.copy).toEqual([".env", ".env.local"]);
    expect(m.setup.install).toEqual(["bun install"]);
    expect(m.setup.generate).toEqual(["bun run codegen"]);
    expect(m.setup.migrate).toEqual(["bun run db:migrate"]);
  });

  test("named ports parsed", () => {
    expect(m.ports.web).toEqual({ base: 3000, range: 100 });
    expect(m.ports.convex).toEqual({ base: 3210, range: 100 });
  });

  test("env parsed", () => {
    expect(m.env).toEqual({ NODE_ENV: "development" });
  });

  test("teardown parsed", () => {
    expect(m.teardown.run).toEqual(["bun run db:reset"]);
  });
});

describe("parseManifestText — Manifest C (with services, full surface)", () => {
  const toml = `
detected = "bun"

[setup]
copy = [".env", "credentials.json"]
install = ["bun install"]

[ports.api]
base = 4000
range = 100

[ports.db]
base = 5432
range = 100

[services.postgres]
mode = "isolated"
start = "pg_ctl -D ./pgdata start"
stop = "pg_ctl -D ./pgdata stop"
port = "$PORT_DB"
ready_check = "tcp:$PORT_DB"
ready_timeout_sec = 45

[services.redis]
mode = "shared"
url = "redis://localhost:6379"
`;
  const m = parseManifestText(toml);

  test("detected label preserved", () => {
    expect(m.detected).toBe("bun");
  });

  test("isolated service: ready_check → readyCheck conversion", () => {
    const pg = m.services.postgres;
    expect(pg).toBeDefined();
    expect(pg?.mode).toBe("isolated");
    expect(pg?.start).toBe("pg_ctl -D ./pgdata start");
    expect(pg?.readyCheck).toBe("tcp:$PORT_DB");
    expect(pg?.readyTimeoutSec).toBe(45);
    expect(pg?.port).toBe("$PORT_DB");
  });

  test("shared service requires url", () => {
    const redis = m.services.redis;
    expect(redis?.mode).toBe("shared");
    expect(redis?.url).toBe("redis://localhost:6379");
  });
});

describe("parseManifestText — backend field", () => {
  test("absent → defaults to 'local'", () => {
    const m = parseManifestText(`[setup]\ninstall = ["x"]\n`);
    expect(m.backend).toBe("local");
  });

  test("explicit backend = 'modal' is preserved", () => {
    const m = parseManifestText(`backend = "modal"\n`);
    expect(m.backend).toBe("modal");
  });

  test("non-string backend → ManifestError", () => {
    expect(() => parseManifestText(`backend = 42\n`)).toThrow(
      /'backend' must be a string/,
    );
  });
});

describe("parseManifestText — [browser] section", () => {
  test("absent [browser] yields default (enabled=false, headless=true, cdp 9222/100)", () => {
    const m = parseManifestText(`[setup]\ninstall = ["bun install"]\n`);
    expect(m.browser.enabled).toBe(false);
    expect(m.browser.headless).toBe(true);
    expect(m.browser.cdpPort).toEqual({ base: 9222, range: 100 });
  });

  test("[browser] enabled=true honored", () => {
    const m = parseManifestText(`[browser]\nenabled = true\n`);
    expect(m.browser.enabled).toBe(true);
    expect(m.browser.headless).toBe(true); // defaulted
  });

  test("[browser] non-headless honored", () => {
    const m = parseManifestText(`[browser]\nenabled = true\nheadless = false\n`);
    expect(m.browser.headless).toBe(false);
  });

  test("[browser.cdp_port] base/range converted to camelCase", () => {
    const m = parseManifestText(
      `[browser]\nenabled = true\n[browser.cdp_port]\nbase = 9300\nrange = 50\n`,
    );
    expect(m.browser.cdpPort).toEqual({ base: 9300, range: 50 });
  });

  test("rejects unknown key in [browser]", () => {
    expect(() => parseManifestText(`[browser]\nfoo = true\n`)).toThrow(
      /unknown key in \[browser\]: 'foo'/,
    );
  });

  test("rejects non-boolean enabled", () => {
    expect(() => parseManifestText(`[browser]\nenabled = "yes"\n`)).toThrow(
      /'browser.enabled' must be a boolean/,
    );
  });

  test("rejects invalid cdp_port.base", () => {
    expect(() =>
      parseManifestText(`[browser]\nenabled = true\n[browser.cdp_port]\nbase = 70000\nrange = 100\n`),
    ).toThrow(/cdp_port.base' must be an integer 1\.\.65535/);
  });
});

describe("parseManifestText — error reporting", () => {
  test("syntax error gets ManifestError with location info", () => {
    expect(() => parseManifestText(`[setup\ninstall = "x"`)).toThrow(ManifestError);
  });

  test("unknown top-level key is rejected loudly", () => {
    expect(() => parseManifestText(`[bogus]\nfoo = 1\n`)).toThrow(/unknown top-level key 'bogus'/);
  });

  test("port with non-integer base", () => {
    expect(() => parseManifestText(`[ports.web]\nbase = "three thousand"\nrange = 100\n`)).toThrow(
      /port 'web': 'base' must be an integer/,
    );
  });

  test("port out of range", () => {
    expect(() => parseManifestText(`[ports.web]\nbase = 70000\nrange = 100\n`)).toThrow(
      /port 'web': 'base' must be an integer 1\.\.65535/,
    );
  });

  test("service with invalid mode", () => {
    expect(() => parseManifestText(`[services.x]\nmode = "bogus"\n`)).toThrow(
      /mode' must be 'shared' or 'isolated'/,
    );
  });

  test("isolated service missing start command", () => {
    expect(() => parseManifestText(`[services.x]\nmode = "isolated"\n`)).toThrow(
      /mode='isolated' requires 'start'/,
    );
  });

  test("shared service missing url", () => {
    expect(() => parseManifestText(`[services.x]\nmode = "shared"\n`)).toThrow(
      /mode='shared' requires 'url'/,
    );
  });

  test("setup.install with non-string element", () => {
    expect(() => parseManifestText(`[setup]\ninstall = ["bun", 42]\n`)).toThrow(
      /'setup\.install\[1\]' must be a string/,
    );
  });

  test("env with non-string value", () => {
    expect(() => parseManifestText(`[env]\nFOO = 42\n`)).toThrow(/env\.FOO must be a string/);
  });

  test("unknown key in [setup]", () => {
    expect(() => parseManifestText(`[setup]\nbogus = ["x"]\n`)).toThrow(
      /unknown key in \[setup\]: 'bogus'/,
    );
  });

  test("unknown key in service table", () => {
    expect(() =>
      parseManifestText(`[services.x]\nmode = "shared"\nurl = "redis://x"\nfoo = "bar"\n`),
    ).toThrow(/unknown key in service 'x': 'foo'/);
  });

  test("error includes file path when provided", () => {
    try {
      parseManifestText(`[ports.web]\nbase = "x"\nrange = 100\n`, "/tmp/workspace.toml");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      const me = e as ManifestError;
      expect(me.file).toBe("/tmp/workspace.toml");
      expect(me.path).toBe("ports.web.base");
    }
  });
});
