import { expect, test } from "bun:test";
import { inputGuard, isDeliveryVerdict } from "./daemon";
import { TmuxServerBusyError } from "./tmux";

test("a busy tmux server retries without regenerating the transcript", () => {
  expect(isDeliveryVerdict(new TmuxServerBusyError())).toBe(true);
  expect(isDeliveryVerdict(new Error("corrupt transcript"))).toBe(false);
});

test("a failed capture retries automatically instead of claiming a human must answer", async () => {
  const check = inputGuard(async () => { throw new Error("tmux timed out"); });
  const error = await check().catch(error => error);
  expect(error.message).toContain("AGENT_STDIN_NOT_READY: terminal capture failed");
  expect(error.holdReason).toBeUndefined();
  expect(error.constructor.name).toBe("Error");
  expect(await check().catch(error => error)).toBe(error);
});

test("a real dialog still requires a human and preserves the screen", async () => {
  const screen = "Ship the change?\n❯ 1. Deploy\n  2. Deny\nEnter to select · Esc to cancel";
  const error = await inputGuard(async () => screen)().catch(error => error);
  expect(error.holdReason).toContain("human answer");
  expect(error.screen).toBe(screen);
});

test("an idle composer beneath completed output accepts queued work", async () => {
  await inputGuard(async () => "The work is complete.\n────────────────────\n❯ \n────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)")();
});
