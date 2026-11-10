// The Image slash command's URL field (lib/editor/askImageUrl mounts it at the
// cursor): the same small form the bubble toolbar shows for a link.
import { useState } from "react";

export function ImageUrlForm({ onSubmit, onCancel }: { onSubmit: (url: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  return (
    <form
      data-image-url-form
      onSubmit={(e) => {
        e.preventDefault();
        const next = url.trim();
        if (next) onSubmit(next);
        else onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      className="bg-sol-bg border border-sol-border/60 rounded-lg shadow-xl flex items-center gap-1.5 p-1.5"
    >
      <input
        type="url"
        aria-label="Image URL"
        placeholder="https://..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="text-xs bg-sol-bg-alt border border-sol-border/50 rounded px-2 py-1 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan w-56"
        autoFocus
      />
      <button type="submit" className="text-xs text-sol-cyan hover:text-sol-text px-2 py-1 rounded hover:bg-sol-bg-highlight">
        Insert
      </button>
      <button type="button" onClick={onCancel} className="text-xs text-sol-text-dim hover:text-sol-text px-1">
        Cancel
      </button>
    </form>
  );
}
