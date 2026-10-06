// Whisk's name as Whisk sets it in its own rail (~/src/mail Rail.tsx
// rail-brand): the envelope in the family accent, then "Whisk" in the
// reading face, italic. Codecast names its mail app this way wherever it hands
// the person to Whisk, so the hand-off reads as one family.
export const WHISK_GLYPH = "✉︎";

export function WhiskWordmark({ className }: { className?: string }) {
  return (
    <span className={className ? `whisk-wordmark ${className}` : "whisk-wordmark"}>
      {/* U+FE0E pins the text presentation; a bare envelope can draw as a colour emoji. */}
      <span className="whisk-wordmark-glyph" aria-hidden>{WHISK_GLYPH}</span>
      <span className="whisk-wordmark-name">Whisk</span>
    </span>
  );
}
