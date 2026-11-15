import { useState } from "react";
import { attachmentKind, type ChatAttachmentView } from "./chatTypes";
import { useStorageImageSrc, useStorageImageUrl } from "../../hooks/useStorageImageUrl";
import { VoicePlayButton } from "./ChatVoiceBubble";
import { ImageLightbox } from "../ImageGallery";

// A chat message's attachments: voice notes, videos and image tiles.

/** One attached image: resolves its storage URL cache-first (byte cache, so a
 *  seen image paints locally and offline), opens the shared lightbox.
 *  A tile that is still resolving keeps its footprint (no reflow when the URL
 *  lands); one that failed says so instead of leaving a hole. */
function AttachmentTile({ att, onOpen }: { att: ChatAttachmentView; onOpen: (src: string) => void }) {
  const url = useStorageImageSrc(att.storage_id);
  // Sent before its upload finished: the local preview, until the store
  // delivers the message with the stored image.
  if (!att.storage_id && att.preview_url) {
    return (
      <span className="ch-att ch-att-uploading" title="Uploading">
        <img src={att.preview_url} alt={att.name || "attachment"} />
        <span className="ch-att-spinner" aria-label="Uploading" />
      </span>
    );
  }
  if (url === null) {
    return <span className="ch-att ch-att-missing">image unavailable</span>;
  }
  return (
    <button
      type="button"
      className="ch-att"
      onClick={() => url && onOpen(url)}
      title={att.name || "View image"}
    >
      {url ? <img src={url} alt={att.name || "attachment"} loading="lazy" /> : <span className="ch-att-loading" />}
    </button>
  );
}

/** One attached video: the browser's own player, streaming from storage.
 *  Only the URL is resolved here; the bytes stay out of the image byte cache,
 *  so a scrolled-past video costs nothing until someone presses play. */
function VideoTile({ att }: { att: ChatAttachmentView }) {
  const url = useStorageImageUrl(att.storage_id);
  if (url === null) return <span className="ch-att ch-att-missing">video unavailable</span>;
  if (!url) return <span className="ch-att ch-att-loading" />;
  return (
    <video
      className="ch-att ch-att-video"
      src={url}
      controls
      playsInline
      preload="metadata"
      title={att.name}
      style={att.width && att.height ? { aspectRatio: `${att.width} / ${att.height}` } : undefined}
    />
  );
}

export function ChatAttachments({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: ChatAttachmentView[];
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  // A recording is not a picture. Every attachment used to go through
  // AttachmentTile, which puts the storage id in an <img> — so a voice note
  // that arrived beside other files rendered as a broken thumbnail with no way
  // to hear it, which is the symptom diagnosis 7 was reported from. A row whose
  // ONLY attachment is audio becomes a voice bubble upstream and never reaches
  // this grid; these are the mixed rows, and they get the same play control the
  // bubble uses rather than a second one invented here.
  const audio = attachments.filter((a) => attachmentKind(a) === "audio");
  const videos = attachments.filter((a) => attachmentKind(a) === "video");
  const images = attachments.filter((a) => attachmentKind(a) === "image");
  return (
    <>
      {audio.map((att) => (
        <div className="ch-voice ch-voice-att" key={att.storage_id || att.preview_url}>
          {/* One player is shared by the whole app, so the key has to name this
              recording and not just its message. */}
          <VoicePlayButton playKey={`${messageId}:${att.storage_id}`} att={att} />
          <span className="ch-voice-text">{att.name || "recording"}</span>
        </div>
      ))}
      {/* Videos never tile: a square crop hides most of a frame. */}
      {videos.length > 0 && (
        <div className="ch-atts">
          {videos.map((att) => <VideoTile key={att.storage_id} att={att} />)}
        </div>
      )}
      {images.length > 0 && (
        <div className={`ch-atts ${images.length > 1 ? "ch-atts-grid" : ""}`}>
          {images.map((att) => (
            <AttachmentTile key={att.storage_id || att.preview_url} att={att} onOpen={setLightbox} />
          ))}
        </div>
      )}
      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}
