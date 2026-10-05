import { expect, test } from "bun:test";
import { codePasteSignInUrl, deviceCodePrompt, oauthApprovalCode, OAUTH_CODE_PASTE_REDIRECT } from "./oauthCodePaste";

// Captured from `claude auth login --claudeai` on 2.1.289 (one PKCE pair).
const browserUrl = "https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A56619%2Fcallback&scope=user%3Ainference&code_challenge=ch&code_challenge_method=S256&state=st";
const pane = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=ch&state=st\nPaste code here if prompted >";

test("the phone URL keeps the PKCE pair and swaps the localhost redirect for the code page", () => {
  const url = new URL(codePasteSignInUrl(browserUrl, pane)!);
  expect(url.searchParams.get("redirect_uri")).toBe(OAUTH_CODE_PASTE_REDIRECT);
  expect(url.searchParams.get("code_challenge")).toBe("ch");
  expect(url.searchParams.get("state")).toBe("st");
});

test("a moved code page follows the CLI's own printout", () => {
  const moved = pane.replace("platform.claude.com", "auth.example.com");
  expect(new URL(codePasteSignInUrl(browserUrl, moved)!).searchParams.get("redirect_uri")).toBe("https://auth.example.com/oauth/code/callback");
  expect(new URL(codePasteSignInUrl(browserUrl)!).searchParams.get("redirect_uri")).toBe(OAUTH_CODE_PASTE_REDIRECT);
});

test("not an OAuth URL", () => {
  expect(codePasteSignInUrl("nonsense")).toBeNull();
  expect(codePasteSignInUrl("https://claude.com/")).toBeNull();
});

test("approval codes", () => {
  expect(oauthApprovalCode(" abc_1-2#st-3 \n")).toBe("abc_1-2#st-3");
  expect(() => oauthApprovalCode("code: abc")).toThrow();
});

test("codex device-code prompt", () => {
  const out = "Follow these steps\n1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code (expires in 15 minutes)\n   E3QB-8GOB3\n";
  expect(deviceCodePrompt(out)).toEqual({ url: "https://auth.openai.com/codex/device", code: "E3QB-8GOB3" });
  expect(deviceCodePrompt("Welcome to Codex")).toBeNull();
});
