// What the mods running for someone ask of agents, as text: `cast mod guide`
// prints it, and the session-start context carries it into every session it
// applies to, so an agent knows a mod's objects and blocks without asking.

export type GuideMod = {
  name: string;
  title?: string;
  description?: string;
  mine?: boolean;
  agents?: string;
  fences: { lang: string; description?: string }[];
  objects: { prefix: string; title: string; statuses?: string[]; fields: string[]; external?: boolean }[];
};

/** Whether a mod gives agents anything to use: its own instructions, a block they can write, or objects they can name. */
export function guidesAgents(m: GuideMod): boolean {
  return !!m.agents || m.fences.length > 0 || m.objects.length > 0;
}

export function formatModGuide(mods: GuideMod[]): string {
  const out: string[] = [];
  for (const m of mods.filter(guidesAgents)) {
    out.push(`## ${m.title ?? m.name}${m.mine === false ? " (shared by your team)" : ""}`);
    if (m.description) out.push(m.description);
    if (m.agents) out.push("", m.agents);
    for (const f of m.fences) out.push(`- \`\`\`${f.lang} blocks draw through it${f.description ? `: ${f.description}` : ""}`);
    const external = m.objects.filter((k) => k.external);
    if (external.length) out.push(`- Ids that draw live, read from where the row lives (the first 8 characters of its id after the prefix; nothing to create first): ${external.map((k) => `${k.prefix}-<id>`).join(", ")}`);
    for (const k of m.objects.filter((k) => !k.external)) {
      out.push(`- ${k.title} objects (${k.prefix}-N): mention one by its short id in prose and it reads as a live reference; file a new one with cast obj create ${k.prefix} "<title>"${k.fields.length ? " [--set <field>=<value>]" : ""}`);
      if (k.fields.length) out.push(`  fields: ${k.fields.join(", ")}${k.statuses?.length ? `; statuses: ${k.statuses.join(" -> ")}` : ""}  (cast obj kinds has their types)`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}
