/**
 * The whole board, done work included (`cast task ls --all`), read a page at a
 * time: one call holding every task of a large team ran out of the server's
 * memory (Union, Oct 26). `page` posts one request to /cli/work/page.
 */
export async function wholeBoard(page: (body: Record<string, any>) => Promise<any>, body: Record<string, any>): Promise<any[]> {
  let tasks: any[] = [];
  for (let cursor: string | null = null, more = true; more && tasks.length < body.limit;) {
    const got = await page({ ...body, cursor, page_size: 300 });
    tasks = [...tasks, ...(got?.tasks ?? [])];
    cursor = got?.cursor ?? null;
    more = cursor !== null;
  }
  return tasks.slice(0, body.limit);
}

/**
 * A workspace listing the paged route answers exactly: no frontier order
 * (--ready), and no filter served by its own index (an assignee, a chain, a
 * project, an initiative, a plan).
 */
export function pageable(body: Record<string, any>): boolean {
  return !body.ready && !body.assignee && !body.chain && !body.project_id && !body.initiative && !body.plan_id;
}

/** The server gave up on a whole-set read: its memory cap or its time limit. */
export function isCapacityError(err: unknown): boolean {
  return /ran out of memory|timed out|Too many (bytes|documents) read/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * `cast task ls`, routed. The whole board (--all, done work included) reads
 * pages, which stay bounded on any team. Every other listing goes to the list
 * route: one indexed range per open status, and the title search index for a
 * search (-q). Paging there would walk the whole task history, done work
 * included, to fill a short open list. When the list route runs out of the
 * server's memory or time (a large team, or a backend from before the search
 * index), the listing walks pages instead, slower but bounded.
 */
export async function listTasks(
  post: (path: string, body: Record<string, any>, opts?: { throwOnError?: boolean }) => Promise<any>,
  body: Record<string, any>,
): Promise<any[]> {
  const page = (b: Record<string, any>) => post("/cli/work/page", b);
  if (!pageable(body)) return post("/cli/work/list", body);
  if (body.include_done && !body.status && !body.query) return wholeBoard(page, body);
  try {
    return await post("/cli/work/list", body, { throwOnError: true });
  } catch (err) {
    if (!isCapacityError(err)) throw err;
    return wholeBoard(page, body);
  }
}
