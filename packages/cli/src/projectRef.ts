// Resolve a project reference the way a person writes one. Agents fill
// `--project` from prompts and conversation, where a project is a NAME
// ("Agent Quality"), never a 32-character Convex id — so every `--project` flag
// accepts an id, a short id, or a title substring, and only the network call
// lives outside this module.

export interface ProjectLike {
  _id: string;
  short_id?: string;
  title?: string;
}

export function looksLikeConvexId(ref: string): boolean {
  return /^[a-z0-9]{28,36}$/.test(ref);
}

export type ProjectMatch =
  | { kind: "id"; id: string }
  | { kind: "empty" }
  | { kind: "one"; id: string }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: ProjectLike[] };

// Classify a reference against the caller's visible projects. Pure — the caller
// turns "none"/"ambiguous" into an error, so the same rules can be tested
// without a server.
export function matchProject(projects: ProjectLike[], ref: string): ProjectMatch {
  // An empty ref is the "clear the project" signal on update, not a lookup.
  if (!ref) return { kind: "empty" };
  if (looksLikeConvexId(ref)) return { kind: "id", id: ref };

  const needle = ref.trim().toLowerCase();
  if (!needle) return { kind: "empty" };

  const matches = (projects || []).filter(
    (p) => p.short_id === ref || p.title?.toLowerCase().includes(needle),
  );

  // An exact title wins over the substring matches that contain it. Without
  // this, "Infrastructure" is ambiguous the moment "Infrastructure v2" exists —
  // and the more precise the name you type, the more it would fail.
  const exact = matches.filter((p) => p.title?.trim().toLowerCase() === needle);
  if (exact.length === 1) return { kind: "one", id: exact[0]._id };

  if (matches.length === 1) return { kind: "one", id: matches[0]._id };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", matches };
}
