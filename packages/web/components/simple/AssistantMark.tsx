// The hosted assistant's one mark: the codecast glyph knocked out of a solid
// ink disc. /welcome draws it large, the inbox marks the person's
// conversations with it (AgentTypeIcon), and the marketing page's way in and
// its picture of a conversation use this component, so a newcomer meets the
// glyph that later marks their own work. Light: the public pages import it.
import { LogoMark } from "../Logo";

export function AssistantMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{ width: size, height: size, background: "var(--pd-ink, #201c17)", color: "var(--pd-bg-raised, #fdfbf6)" }}
    >
      <LogoMark monochrome className="h-[62%] w-[62%]" />
    </span>
  );
}
