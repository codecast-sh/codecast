const LABEL_COLORS: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  bug: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/30", dot: "bg-red-400" },
  feature: { bg: "bg-blue-500/10", text: "text-blue-400", border: "border-blue-500/30", dot: "bg-blue-400" },
  improvement: { bg: "bg-cyan-500/10", text: "text-cyan-400", border: "border-cyan-500/30", dot: "bg-cyan-400" },
  refactor: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/30", dot: "bg-amber-400" },
  docs: { bg: "bg-indigo-500/10", text: "text-indigo-400", border: "border-indigo-500/30", dot: "bg-indigo-400" },
  infra: { bg: "bg-slate-500/10", text: "text-slate-400", border: "border-slate-500/30", dot: "bg-slate-400" },
  design: { bg: "bg-pink-500/10", text: "text-pink-400", border: "border-pink-500/30", dot: "bg-pink-400" },
  perf: { bg: "bg-orange-500/10", text: "text-orange-400", border: "border-orange-500/30", dot: "bg-orange-400" },
  security: { bg: "bg-yellow-500/10", text: "text-yellow-400", border: "border-yellow-500/30", dot: "bg-yellow-400" },
  testing: { bg: "bg-green-500/10", text: "text-green-400", border: "border-green-500/30", dot: "bg-green-400" },
  urgent: { bg: "bg-rose-500/10", text: "text-rose-400", border: "border-rose-500/30", dot: "bg-rose-400" },
  blocked: { bg: "bg-neutral-500/10", text: "text-neutral-400", border: "border-neutral-500/30", dot: "bg-neutral-400" },
};

const HASH_PALETTE = [
  { bg: "bg-violet-500/10", text: "text-violet-400", border: "border-violet-500/30", dot: "bg-violet-400" },
  { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/30", dot: "bg-emerald-400" },
  { bg: "bg-fuchsia-500/10", text: "text-fuchsia-400", border: "border-fuchsia-500/30", dot: "bg-fuchsia-400" },
  { bg: "bg-teal-500/10", text: "text-teal-400", border: "border-teal-500/30", dot: "bg-teal-400" },
  { bg: "bg-lime-500/10", text: "text-lime-400", border: "border-lime-500/30", dot: "bg-lime-400" },
  { bg: "bg-sky-500/10", text: "text-sky-400", border: "border-sky-500/30", dot: "bg-sky-400" },
];

export function getLabelColor(name: string) {
  const lower = name.toLowerCase();
  if (LABEL_COLORS[lower]) return LABEL_COLORS[lower];
  let hash = 0;
  for (let i = 0; i < lower.length; i++) hash = ((hash << 5) - hash + lower.charCodeAt(i)) | 0;
  return HASH_PALETTE[Math.abs(hash) % HASH_PALETTE.length];
}

export const DEFAULT_LABELS = Object.keys(LABEL_COLORS);
