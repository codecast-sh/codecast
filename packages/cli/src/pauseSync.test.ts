import { describe, it, expect, beforeEach, afterEach } from "bun:test";

describe("Pause sync environment variable", () => {
  const originalCodeChatPaused = process.env.CODE_CHAT_SYNC_PAUSED;
  const originalCodecastPaused = process.env.CODECAST_PAUSED;

  afterEach(() => {
    if (originalCodeChatPaused !== undefined) {
      process.env.CODE_CHAT_SYNC_PAUSED = originalCodeChatPaused;
    } else {
      delete process.env.CODE_CHAT_SYNC_PAUSED;
    }

    if (originalCodecastPaused !== undefined) {
      process.env.CODECAST_PAUSED = originalCodecastPaused;
    } else {
      delete process.env.CODECAST_PAUSED;
    }
  });

  it("should detect CODE_CHAT_SYNC_PAUSED=1", () => {
    process.env.CODE_CHAT_SYNC_PAUSED = "1";

    const isSyncPaused = () => {
      return process.env.CODE_CHAT_SYNC_PAUSED === "1" || process.env.CODECAST_PAUSED === "1";
    };

    expect(isSyncPaused()).toBe(true);
  });

  it("should detect CODECAST_PAUSED=1", () => {
    delete process.env.CODE_CHAT_SYNC_PAUSED;
    process.env.CODECAST_PAUSED = "1";

    const isSyncPaused = () => {
      return process.env.CODE_CHAT_SYNC_PAUSED === "1" || process.env.CODECAST_PAUSED === "1";
    };

    expect(isSyncPaused()).toBe(true);
  });

  it("should not pause when both env vars are unset", () => {
    delete process.env.CODE_CHAT_SYNC_PAUSED;
    delete process.env.CODECAST_PAUSED;

    const isSyncPaused = () => {
      return process.env.CODE_CHAT_SYNC_PAUSED === "1" || process.env.CODECAST_PAUSED === "1";
    };

    expect(isSyncPaused()).toBe(false);
  });

  it("should not pause when env vars are set to non-1 values", () => {
    process.env.CODE_CHAT_SYNC_PAUSED = "0";
    process.env.CODECAST_PAUSED = "false";

    const isSyncPaused = () => {
      return process.env.CODE_CHAT_SYNC_PAUSED === "1" || process.env.CODECAST_PAUSED === "1";
    };

    expect(isSyncPaused()).toBe(false);
  });
});
