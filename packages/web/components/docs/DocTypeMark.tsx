import { docTypeIcon, docTypeStyle } from "../../lib/docTypeStyle";

/** A doc's type at a glance: the artifact types' icon, else the type's dot. */
export function DocTypeMark({ type, size = 14, title }: { type: string; size?: number; title?: string }) {
  const style = docTypeStyle(type);
  const Icon = docTypeIcon(type);
  if (Icon) return <Icon className={`shrink-0 ${style.color}`} style={{ width: size, height: size }} strokeWidth={1.75} aria-label={title} />;
  return (
    <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} title={title}>
      <span className={`w-2 h-2 rounded-full ${style.dot}`} />
    </span>
  );
}
