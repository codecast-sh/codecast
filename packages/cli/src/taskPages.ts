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
