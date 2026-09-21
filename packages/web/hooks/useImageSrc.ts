import { useStorageImageUrl } from "./useStorageImageUrl";
import { imageBytes } from "../lib/imageByteCache";
import type { ImageData } from "../components/conversation/types";

// Batched + cross-mount-cached URL resolution: one query for all visible
// images, and a remount (virtualized scroll) reuses the cached URL instead of
// re-subscribing and re-flashing "Loading…". Bytes are cache-first too
// (useStorageImageSrc): a seen image paints from the local byte cache, and the
// history prefetch warms it before the block ever mounts.
export function useImageSrc(image: ImageData): { src: string | undefined; href: string | undefined; storageResolved: boolean; storageMissing: boolean } {
  // storageUrl: undefined = still resolving, null = not found, string = the
  // serving URL (the image's shareable address). storageSrc is the cache-first
  // paint src for it — an object URL once the bytes are local.
  const storageUrl = useStorageImageUrl(image.storage_id);
  const cachedSrc = imageBytes.useSrc(typeof storageUrl === "string" ? storageUrl : undefined);
  const storageSrc = typeof storageUrl === "string" ? cachedSrc : storageUrl;
  const storageResolved = image.storage_id ? storageSrc !== undefined : true;
  const storageMissing = Boolean(image.storage_id) && storageSrc === null;
  const href = typeof storageUrl === "string" ? storageUrl : undefined;

  // While uploading we only have the local blob: preview. After the upload
  // resolves we prefer the real storage src but fall back to the preview until
  // it resolves, so the thumbnail never flickers to "Loading…".
  const src = image.uploading && image.preview_url
    ? image.preview_url
    : image.storage_id
      ? (typeof storageSrc === "string" ? storageSrc : image.preview_url || undefined)
      : image.data
        ? `data:${image.media_type};base64,${image.data}`
        : image.preview_url || undefined;
  return { src, href, storageResolved, storageMissing };
}
