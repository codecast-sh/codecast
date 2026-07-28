import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  renderProviderEnvFile,
  syncProviderKeyEnvFile,
  providerKeySourcePrefix,
  clientUsesProviderKeys,
} from "./providerKeyLaunch";
import { writeProviderKeyStore } from "./providerKeyStore";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pk-test-"));
}
const ENV_FILE = "agent-provider-env.sh";

describe("provider-key launch injection", () => {
  it("injects only for clients that read provider env vars (not Claude/Codex subscription auth)", () => {
    expect(clientUsesProviderKeys("opencode")).toBe(true);
    expect(clientUsesProviderKeys("pi")).toBe(true);
    // Injecting ANTHROPIC_API_KEY into Claude could redirect it off the subscription.
    expect(clientUsesProviderKeys("claude")).toBe(false);
    expect(clientUsesProviderKeys("codex")).toBe(false);
  });

  it("renders a shell-safe env file, single-quoting values so a metachar key can't break out", () => {
    const out = renderProviderEnvFile({ OPENROUTER_API_KEY: "sk-or-a'; rm -rf ~ #" });
    expect(out).toBe("export OPENROUTER_API_KEY='sk-or-a'\\''; rm -rf ~ #'\n");
  });

  it("writes a 0600 file for managed keys and removes it when none are set (the default)", () => {
    const dir = tmpDir();
    try {
      writeProviderKeyStore(dir, { openrouter: "sk-or-x" });
      const file = syncProviderKeyEnvFile(dir);
      expect(file).toBe(path.join(dir, ENV_FILE));
      expect((fs.statSync(file!).mode & 0o777).toString(8)).toBe("600");
      expect(fs.readFileSync(file!, "utf-8")).toContain("OPENROUTER_API_KEY='sk-or-x'");
      // No managed keys → file removed, nothing injected.
      writeProviderKeyStore(dir, {});
      expect(syncProviderKeyEnvFile(dir)).toBe(null);
      expect(fs.existsSync(path.join(dir, ENV_FILE))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("source prefix sources the file by PATH — the key itself never appears on the command line", () => {
    const dir = tmpDir();
    try {
      writeProviderKeyStore(dir, { openrouter: "sk-or-secret" });
      const prefix = providerKeySourcePrefix("opencode", dir);
      expect(prefix).toContain(`. ${path.join(dir, ENV_FILE)}`);
      expect(prefix).toContain("2>/dev/null || true;");
      // The point: the secret is in the 0600 file, NOT in the prefix that reaches `ps`.
      expect(prefix).not.toContain("sk-or-secret");
      // A client that doesn't use provider keys gets no prefix, even with keys set.
      expect(providerKeySourcePrefix("claude", dir)).toBe("");
      // No managed keys → no prefix (default: system auth).
      writeProviderKeyStore(dir, {});
      expect(providerKeySourcePrefix("opencode", dir)).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
