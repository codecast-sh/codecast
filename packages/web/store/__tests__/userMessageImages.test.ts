import { describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

describe("navigator attachment cache", () => {
  test("adopts attachments added to a cached message without changing IDs or counts", () => {
    const id = "image-cache-regression";
    const message = { _id: "prompt", role: "user" as const, content: "[Image 1] Fix this", timestamp: 1 };
    useInboxStore.getState().setUserMessages(id, [message]);
    const richer = { ...message, images: [{ media_type: "image/png", storage_id: "image-one" }] };
    useInboxStore.getState().setUserMessages(id, [richer]);
    const cached = useInboxStore.getState().userMessages[id];
    expect(cached[0].images).toEqual(richer.images);
    useInboxStore.getState().setUserMessages(id, [{ ...richer, images: richer.images.map(image => ({ ...image })) }]);
    expect(useInboxStore.getState().userMessages[id]).toBe(cached);
    useInboxStore.getState().setUserMessages(id, [{ ...richer, images: [] }]);
    expect(useInboxStore.getState().userMessages[id][0].images).toEqual([]);
  });
});
