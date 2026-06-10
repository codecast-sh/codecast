import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { persistDraftImages, restoreDraftImages, settleDraftImageUpload, type PastedImage } from "../draftImages";

const pastedImage = (over: Partial<PastedImage> = {}): PastedImage => ({
  file: new File([], "shot.png", { type: "image/png" }),
  previewUrl: "blob:http://local/abc-123",
  uploading: true,
  ...over,
});

describe("draftImages", () => {
  beforeEach(() => {
    useInboxStore.setState({ drafts: {}, clientState: {} });
  });

  it("persists a still-uploading image to the draft at paste time", () => {
    persistDraftImages("conv1", "", [pastedImage()]);

    const rows = useInboxStore.getState().getDraft("conv1")?.draft_image_storage_ids;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      previewUrl: "blob:http://local/abc-123",
      name: "shot.png",
      type: "image/png",
      uploading: true,
    });
    expect(rows[0].storageId).toBeUndefined();
  });

  it("restores uploading rows across a composer remount", () => {
    // The composer remounts when a new session gets its session_id stamped
    // (key flip); a freshly-pasted image must come back from the draft.
    persistDraftImages("conv1", "look at this", [pastedImage()]);

    const restored = restoreDraftImages(useInboxStore.getState().getDraft("conv1"));
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      previewUrl: "blob:http://local/abc-123",
      uploading: true,
    });
    expect(restored[0].file.name).toBe("shot.png");
    expect(restored[0].file.type).toBe("image/png");
    expect(useInboxStore.getState().getDraft("conv1")?.draft_message).toBe("look at this");
  });

  it("settles an upload into the draft by previewUrl, with no composer mounted", () => {
    persistDraftImages("conv1", "", [pastedImage()]);

    settleDraftImageUpload("blob:http://local/abc-123", "storage-1");

    const rows = useInboxStore.getState().getDraft("conv1")?.draft_image_storage_ids;
    expect(rows[0]).toMatchObject({ storageId: "storage-1" });
    const restored = restoreDraftImages(useInboxStore.getState().getDraft("conv1"));
    expect(restored[0].uploading).toBe(false);
  });

  it("settles an upload after the draft was rekeyed (stub conversation -> real id)", () => {
    persistDraftImages("stub1", "", [pastedImage()]);

    useInboxStore.getState()._rekeySession("stub1", "real1");
    settleDraftImageUpload("blob:http://local/abc-123", "storage-1");

    expect(useInboxStore.getState().getDraft("stub1")).toBeUndefined();
    const rows = useInboxStore.getState().getDraft("real1")?.draft_image_storage_ids;
    expect(rows[0]).toMatchObject({ storageId: "storage-1", previewUrl: "blob:http://local/abc-123" });
  });

  it("removes the row on a failed upload, clearing an otherwise-empty draft", () => {
    persistDraftImages("conv1", "", [pastedImage()]);

    settleDraftImageUpload("blob:http://local/abc-123", null);

    expect(useInboxStore.getState().getDraft("conv1")).toBeUndefined();
  });

  it("keeps draft text when a failed upload removes the last image", () => {
    persistDraftImages("conv1", "keep me", [pastedImage()]);

    settleDraftImageUpload("blob:http://local/abc-123", null);

    const draft = useInboxStore.getState().getDraft("conv1");
    expect(draft?.draft_message).toBe("keep me");
    expect(draft?.draft_image_storage_ids).toBeNull();
  });

  it("restores uploaded rows and the legacy single-image draft shape", () => {
    persistDraftImages("conv1", "", [pastedImage({ storageId: "storage-9", uploading: false })]);
    const restored = restoreDraftImages(useInboxStore.getState().getDraft("conv1"));
    expect(restored[0]).toMatchObject({ storageId: "storage-9", uploading: false });

    const legacy = restoreDraftImages({
      draft_image_storage_id: "storage-old",
      draft_image_name: "old.png",
      draft_image_preview: "blob:http://local/old",
    });
    expect(legacy[0]).toMatchObject({ storageId: "storage-old", previewUrl: "blob:http://local/old", uploading: false });
  });
});
