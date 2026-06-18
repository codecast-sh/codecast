import { Bot } from "lucide-react";

// Small round avatar for a comment author. Image when we have one, otherwise a
// colored initial (deterministic hue per name, matching the presence facepile
// vibe). The agent gets a distinct violet bot chip so its replies read as
// machine-authored at a glance.

const HUES = ["#268bd2", "#2aa198", "#859900", "#b58900", "#cb4b16", "#d33682", "#6c71c4"];

function hueFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export function CommentAvatar({
  name,
  image,
  isAgent,
  size = 22,
}: {
  name: string;
  image?: string;
  isAgent?: boolean;
  size?: number;
}) {
  if (isAgent) {
    return (
      <span
        className="cc-cmt-avatar grid place-items-center shrink-0 rounded-full text-sol-violet bg-sol-violet/15 ring-1 ring-sol-violet/30"
        style={{ width: size, height: size }}
        title="Agent"
      >
        <Bot style={{ width: size * 0.6, height: size * 0.6 }} />
      </span>
    );
  }
  if (image) {
    return (
      <img
        src={image}
        alt={name}
        title={name}
        className="cc-cmt-avatar shrink-0 rounded-full object-cover ring-1 ring-sol-border/40"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="cc-cmt-avatar grid place-items-center shrink-0 rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), backgroundColor: hueFor(name) }}
      title={name}
    >
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}
