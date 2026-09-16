import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserHandoffCard } from "../BrowserHandoffToast";

const session = {
  title: "Staffing layer analyzer",
  short_id: "jx71b14",
  status: "active",
  is_active: true,
  agent_type: "claude_code",
  idle_summary: "Retire interactive walk in cast org apply, await typecheck",
  last_message_preview: "please fix the org apply walk",
  last_message_role: "user",
  message_count: 971,
  model: "claude-opus-fable",
  project_path: "/Users/ashot/src/codecast",
  updated_at: Date.now() - 4_000,
};

function render(ui: React.ReactElement) {
  return renderToStaticMarkup(ui);
}

describe("BrowserHandoffCard", () => {
  test("the loaded card is a notice, not a hover popover", () => {
    const html = render(
      <BrowserHandoffCard path="/conversation/jx71b14" session={session} onOpen={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain("From the browser");
    expect(html).toContain("Staffing layer analyzer");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Active");
    expect(html).toContain("Retire interactive walk");
    expect(html).toContain("please fix the org apply walk");
    expect(html).toContain("971 messages");
    expect(html).toContain("Fable");
    expect(html).toContain("codecast");
    expect(html).toContain("Open session");
    expect(html).toContain("Not now");
    expect(html).toContain("handoff-toast");
    expect(html).not.toContain("Click to open");
    expect(html).not.toContain("Browser handed off");
  });

  test("a page handoff with no session still opens and dismisses", () => {
    const html = render(
      <BrowserHandoffCard path="/docs/readme" session={null} onOpen={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain("From the browser");
    expect(html).toContain("/docs/readme");
    expect(html).toContain(">Open<");
    expect(html).toContain("Not now");
    expect(html).not.toContain("Open session");
  });

  test("the skeleton is the loading state, not an empty card", () => {
    const html = render(
      <BrowserHandoffCard path="/conversation/abc" session={null} loading onOpen={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain("handoff-toast-skel");
    expect(html).toContain("Not now");
  });

  test("Open session and Not now fire the matching callbacks", () => {
    const html = render(
      <BrowserHandoffCard path="/conversation/jx71b14" session={session} onOpen={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain("handoff-toast-open");
    expect(html).toContain("handoff-toast-stay");
    expect(html).toContain('type="button"');
  });
});
