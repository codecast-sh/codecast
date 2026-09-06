import fs from 'node:fs';
import { extractCwd } from '../parser.js';
export async function readTranscriptCwdAsync(file: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file,'r');
    const buffer = Buffer.alloc(64*1024);
    const {bytesRead} = await handle.read(buffer,0,buffer.length,0);
    let head = buffer.toString('utf8',0,bytesRead);
    if (bytesRead === buffer.length) { const end=head.lastIndexOf('\n'); head=end>=0 ? head.slice(0,end+1) : ''; }
    return head ? extractCwd(head,{quiet:true}) ?? null : null;
  } catch { return null; }
  finally { await handle?.close(); }
}
