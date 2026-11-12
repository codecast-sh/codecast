import { describe, expect, test } from "bun:test";
import { fitWebhookPayload, WEBHOOK_PAYLOAD_MAX_BYTES } from "./webhookPayload";

describe("fitWebhookPayload", () => {
  test("a payload that fits is returned unchanged", () => {
    const p = JSON.stringify({ ref: "refs/heads/main", commits: [{ id: "a" }] });
    expect(fitWebhookPayload(p)).toBe(p);
  });

  test("an oversized push keeps its identifying fields and fits", () => {
    const files = Array.from({ length: 30_000 }, (_, i) => `packages/web/components/generated/File${i}.tsx`);
    const raw = JSON.stringify({
      ref: "refs/heads/main", after: "f".repeat(40), repository: { full_name: "acme/app" },
      head_commit: { id: "f".repeat(40), message: "big refactor" },
      commits: [{ id: "f".repeat(40), message: "big refactor", added: files, modified: files, removed: [] }],
    });
    expect(raw.length).toBeGreaterThan(WEBHOOK_PAYLOAD_MAX_BYTES);
    const fitted = fitWebhookPayload(raw);
    expect(new TextEncoder().encode(fitted).length).toBeLessThanOrEqual(WEBHOOK_PAYLOAD_MAX_BYTES);
    const p = JSON.parse(fitted);
    expect([p.ref, p.after, p.repository.full_name, p.commits[0].id]).toEqual(["refs/heads/main", "f".repeat(40), "acme/app", "f".repeat(40)]);
    expect(p.commits[0].added.length).toBeGreaterThan(0);
  });

  test("a huge PR body is cut, not the PR", () => {
    const raw = JSON.stringify({ action: "opened", pull_request: { number: 7, body: "x".repeat(2_000_000) } });
    const p = JSON.parse(fitWebhookPayload(raw));
    expect(p.pull_request.number).toBe(7);
    expect(p.pull_request.body.length).toBeLessThan(10_000);
  });
});
