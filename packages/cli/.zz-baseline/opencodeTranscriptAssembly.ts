export interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  version: string | null;
  project_id: string | null;
  slug: string | null;
  time_created: number;
  time_updated: number;
}

export function assembleOpencodeRows(session: SessionRow, messageRows: {id:string;data:string}[], partRows: {message_id:string;id:string;data:string}[], strict = false): string | null {
    const partsByMessage = new Map<string, unknown[]>();
    for (const row of partRows) {
      let part: Record<string, unknown>;
      try { part = JSON.parse(row.data); } catch (error) { if (strict) throw error; continue; }
      part.id = row.id; // id is the column, not in data
      let list = partsByMessage.get(row.message_id);
      if (!list) { list = []; partsByMessage.set(row.message_id, list); }
      list.push(part);
    }

    const messages: { info: unknown; parts: unknown[] }[] = [];
    for (const row of messageRows) {
      let info: Record<string, unknown>;
      try { info = JSON.parse(row.data); } catch (error) { if (strict) throw error; continue; }
      info.id = row.id;
      messages.push({ info, parts: partsByMessage.get(row.id) ?? [] });
    }
    if (messages.length === 0) return null;

    const info = {
      id: session.id,
      title: session.title ?? undefined,
      directory: session.directory ?? undefined,
      version: session.version ?? undefined,
      projectID: session.project_id ?? undefined,
      slug: session.slug ?? undefined,
      time: { created: session.time_created, updated: session.time_updated },
    };
    return JSON.stringify({ info, messages });
}
