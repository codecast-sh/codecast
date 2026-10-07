// Codecast's wordmark wherever the assistant's family look is (hosted mode's
// rail, /welcome, the marketing pages reached through the assistant's door):
// the mark in ink and the name in the reading face, as Whisk sets its own.
// One component, so the three steps a newcomer takes from codecast.sh into
// the app show one name. The developer marketing bar keeps its mono Logo.
// Light on purpose: the public pages import it.
import { LogoMark } from "./Logo";

export function HostedWordmark({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      data-cc-hosted-wordmark
      className={`inline-flex items-center gap-2 ${className}`}
      style={{ fontFamily: "var(--pd-font-read, Georgia, serif)", fontWeight: 600, letterSpacing: "-0.01em", color: "var(--pd-ink, #201c17)" }}
    >
      <LogoMark size={size} monochrome className="shrink-0" />
      <span>Codecast</span>
    </span>
  );
}
