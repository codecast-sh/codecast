export function scopedRepoSearch(repository: string, query: string): string {
  const terms = query.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
  return [...terms.filter((term) => !/^-?(repo|org|user):/i.test(term)), `repo:${repository}`].join(" ");
}

export function belongsToSearchRepository(item: { repository?: { full_name?: string }; url?: string }, repository: string): boolean {
  return item.repository?.full_name?.toLowerCase() === repository.toLowerCase();
}
