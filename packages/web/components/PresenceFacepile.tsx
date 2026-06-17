// Avatar stack for live presence — a colored initial per person, where the color
// is the same one used for that person's editor cursor, so the facepile and the
// cursors read as the same identity. Shared by the chat composer's co-presence
// bar and the expanded doc view's "who's in here" header.

export type PresenceFace = {
  user_id: string;
  user_name: string;
  user_color: string;
};

export function PresenceFacepile({
  present,
  max = 4,
  size = 20,
}: {
  present: PresenceFace[];
  max?: number;
  size?: number;
}) {
  if (present.length === 0) return null;
  const shown = present.slice(0, max);
  const overflow = present.length - shown.length;
  return (
    <div className="flex -space-x-1.5 shrink-0">
      {shown.map((p) => (
        <span
          key={p.user_id}
          title={p.user_name}
          className="rounded-full grid place-items-center font-semibold text-sol-bg ring-2 ring-sol-bg"
          style={{
            width: size,
            height: size,
            fontSize: Math.round(size * 0.5),
            backgroundColor: p.user_color,
          }}
        >
          {(p.user_name || "?").charAt(0).toUpperCase()}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="rounded-full grid place-items-center font-semibold text-sol-text-dim bg-sol-bg-alt ring-2 ring-sol-bg"
          style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
