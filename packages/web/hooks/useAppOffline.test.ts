import { describe, expect, it } from "bun:test";
import { WEBSOCKET_HANDSHAKE_TIMEOUT_MS } from "@codecast/shared/network";
import {
  DISCONNECT_GRACE_MS,
  connectionChipCopy,
  connectionNotice,
} from "./useAppOffline";

describe("DISCONNECT_GRACE_MS", () => {
  it("outlasts the recovering socket handshake so a healthy connect cannot flash Reconnecting", () => {
    expect(DISCONNECT_GRACE_MS).toBeGreaterThan(WEBSOCKET_HANDSHAKE_TIMEOUT_MS);
  });
});

describe("connectionNotice", () => {
  it("stays quiet when the socket is up", () => {
    expect(connectionNotice({ offline: false, online: true })).toBeNull();
    expect(connectionNotice({ offline: false, online: false })).toBeNull();
  });

  it("does not raise a card for a dropped socket while the OS is online", () => {
    // Local-first: the cache is already serving. The header LED carries this.
    expect(connectionNotice({ offline: true, online: true })).toBeNull();
  });

  it("raises Offline when the OS has no network", () => {
    const notice = connectionNotice({ offline: true, online: false });
    expect(notice?.title).toBe("Offline");
    expect(notice?.detail).toMatch(/cached/i);
  });
});

describe("connectionChipCopy", () => {
  it("is silent when we can sync", () => {
    expect(connectionChipCopy({ offline: false, online: true })).toBeNull();
  });

  it("names a dropped socket Reconnecting so the header LED can carry it", () => {
    expect(connectionChipCopy({ offline: true, online: true })?.label).toBe("Reconnecting");
  });

  it("names a dead network Offline", () => {
    expect(connectionChipCopy({ offline: true, online: false })?.label).toBe("Offline");
  });
});
