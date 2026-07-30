import { describe, expect, test } from "bun:test";
import { batchHasLoopEvent, deriveLoopState, type LoopState } from "./loopState";

const NOW = 1_700_000_000_000;

const arm = (ts: number, delaySeconds = 1200, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  timestamp: ts,
  tool_calls: [
    {
      name: "ScheduleWakeup",
      input: JSON.stringify({ delaySeconds, reason: "watching CI run", prompt: "/loop check ci", ...extra }),
    },
  ],
});

const fire = (ts: number) => ({
  role: "system",
  subtype: "scheduled_task_fire",
  timestamp: ts,
  content: "Claude resuming /loop wakeup",
});

const stop = (ts: number) => ({
  role: "assistant",
  timestamp: ts,
  tool_calls: [{ name: "ScheduleWakeup", input: JSON.stringify({ stop: true }) }],
});

describe("batchHasLoopEvent", () => {
  test("detects wakeup tool calls and fire messages, skips ordinary traffic", () => {
    expect(batchHasLoopEvent([arm(NOW)])).toBe(true);
    expect(batchHasLoopEvent([fire(NOW)])).toBe(true);
    expect(
      batchHasLoopEvent([
        { role: "assistant", timestamp: NOW, tool_calls: [{ name: "Bash", input: "{}" }] },
        { role: "user", timestamp: NOW, content: "hi" } as any,
      ]),
    ).toBe(false);
  });
});

describe("deriveLoopState", () => {
  test("arm creates an armed state with wakeup_at = ts + delay", () => {
    const s = deriveLoopState(undefined, [arm(NOW, 1200)], NOW)!;
    expect(s.status).toBe("armed");
    expect(s.wakeup_at).toBe(NOW + 1200_000);
    expect(s.armed_at).toBe(NOW);
    expect(s.reason).toBe("watching CI run");
    expect(s.prompt).toBe("/loop check ci");
  });

  test("delay is clamped to the runtime's [60, 3600]s window", () => {
    expect(deriveLoopState(undefined, [arm(NOW, 5)], NOW)!.wakeup_at).toBe(NOW + 60_000);
    expect(deriveLoopState(undefined, [arm(NOW, 90_000)], NOW)!.wakeup_at).toBe(NOW + 3600_000);
  });

  test("fire flips to waking and keeps the arm's reason/prompt", () => {
    const armed = deriveLoopState(undefined, [arm(NOW)], NOW)!;
    const s = deriveLoopState(armed, [fire(NOW + 1200_000)], NOW)!;
    expect(s.status).toBe("waking");
    expect(s.fired_at).toBe(NOW + 1200_000);
    expect(s.reason).toBe("watching CI run");
  });

  test("fire with no prior record seeds a waking state (mid-loop backfill)", () => {
    const s = deriveLoopState(undefined, [fire(NOW)], NOW)!;
    expect(s.status).toBe("waking");
    expect(s.fired_at).toBe(NOW);
  });

  test("re-arm after a fire returns to armed with the new wakeup", () => {
    const s = deriveLoopState(undefined, [arm(NOW), fire(NOW + 1200_000), arm(NOW + 1201_000, 600)], NOW)!;
    expect(s.status).toBe("armed");
    expect(s.wakeup_at).toBe(NOW + 1201_000 + 600_000);
    expect(s.fired_at).toBe(NOW + 1200_000);
  });

  test("stop tombstones the loop", () => {
    const armed = deriveLoopState(undefined, [arm(NOW)], NOW)!;
    const s = deriveLoopState(armed, [stop(NOW + 5_000)], NOW)!;
    expect(s.status).toBe("stopped");
    expect(s.event_at).toBe(NOW + 5_000);
  });

  test("a stop with no loop records nothing", () => {
    expect(deriveLoopState(undefined, [stop(NOW)], NOW)).toBeUndefined();
  });

  test("replayed older batches cannot regress the state", () => {
    const stopped = deriveLoopState(undefined, [arm(NOW), stop(NOW + 10_000)], NOW)!;
    // A historical re-sync replays the original arm — must not re-arm.
    expect(deriveLoopState(stopped, [arm(NOW)], NOW)).toBeUndefined();
  });

  test("events inside one batch apply in timestamp order regardless of array order", () => {
    const s = deriveLoopState(undefined, [arm(NOW + 2_000, 600), fire(NOW + 1_000)], NOW)!;
    expect(s.status).toBe("armed");
    expect(s.wakeup_at).toBe(NOW + 2_000 + 600_000);
  });

  test("no loop events → undefined (caller skips the patch)", () => {
    const prev: LoopState = {
      status: "armed",
      wakeup_at: NOW + 60_000,
      armed_at: NOW,
      event_at: NOW,
    };
    expect(deriveLoopState(prev, [{ role: "user", timestamp: NOW + 1, content: "hi" } as any], NOW)).toBeUndefined();
  });

  test("identical re-derivation is a no-op", () => {
    const s = deriveLoopState(undefined, [arm(NOW)], NOW)!;
    expect(deriveLoopState(s, [arm(NOW)], NOW)).toBeUndefined();
  });
});
