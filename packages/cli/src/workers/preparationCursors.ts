import { beginMessagePreparation, finishPreparationMessage, preparationImagePaths, replacePreparationImageLinks, type PreparationImage, type PreparationMessage } from '../messagePreparation.js';
import { IngestAssembler, ingestTokenPages } from './ingestTransport.js';
import { PREPARATION_COMPUTE_MS, PREPARATION_LIFETIME_MS, PREPARATION_MAX_CURSORS, type PreparationPage, type PreparationPayload } from './preparationTypes.js';
import type { IngestToken } from './ingestTypes.js';

type Cursor = {
  generation: string;
  sequence: number;
  origin: 'transcript' | 'service';
  input?: IngestAssembler;
  imageIndex?: number;
  messages?: PreparationMessage[];
  paths?: { index: number; values: string[] };
  output?: AsyncGenerator<IngestToken[]>;
  busy: boolean;
  expires: number;
  remaining: number;
  timer: ReturnType<typeof setTimeout>;
};

export class PreparationCursors {
  private cursors = new Map<string, Cursor>();
  constructor(private readonly now = () => performance.now()) {}
  get size() { return this.cursors.size; }
  private async remove(key: string) {
    const cursor = this.cursors.get(key);
    if (!cursor) return;
    this.cursors.delete(key);
    clearTimeout(cursor.timer);
    await cursor.output?.return(undefined);
  }
  async request(payload: PreparationPayload, id: string): Promise<PreparationPage> {
    const started = this.now(), key = payload.action === 'open' ? id : payload.cursor;
    if (payload.action === 'open') {
      if (this.cursors.size >= PREPARATION_MAX_CURSORS || this.cursors.has(key)) throw new Error('preparation busy');
      const timer = setTimeout(() => { void this.remove(key); }, PREPARATION_LIFETIME_MS);
      timer.unref();
      this.cursors.set(key, { generation: payload.generation, sequence: 0, origin: payload.origin, input: new IngestAssembler(), busy: false, expires: started + PREPARATION_LIFETIME_MS, remaining: PREPARATION_COMPUTE_MS, timer });
    }
    const cursor = this.cursors.get(key);
    if (!cursor || cursor.busy || cursor.generation !== payload.generation || payload.action !== 'open' && payload.sequence !== cursor.sequence) throw new Error('invalid preparation cursor');
    cursor.busy = true;
    try {
      if (started >= cursor.expires || cursor.remaining <= 0) throw new Error('preparation expired');
      let tokens: IngestToken[] = [], done = true;
      if (payload.action === 'close') await this.remove(key);
      else if (payload.action === 'push') {
        if (!cursor.input || cursor.output) throw new Error('preparation not receiving input');
        cursor.input.push(payload.tokens);
      } else if (payload.action === 'seal') {
        if (!cursor.input || cursor.output) throw new Error('preparation not receiving input');
        const value = cursor.input.finish();
        cursor.input = undefined;
        if (!Array.isArray(value)) throw new Error('invalid preparation input');
        if (cursor.imageIndex !== undefined) {
          if (value.length > 10 || value.some(img => !img || typeof img.mediaType !== 'string' || typeof img.storageId !== 'string' && typeof img.data !== 'string')) throw new Error('invalid prepared images');
          cursor.messages![cursor.imageIndex].images = value as PreparationImage[];
          cursor.imageIndex = undefined;
        } else {
          if (cursor.messages || value.some(msg => !msg || typeof msg.content !== 'string' || typeof msg.role !== 'string' || !Number.isFinite(msg.timestamp))) throw new Error('invalid preparation messages');
          cursor.messages = beginMessagePreparation(value, cursor.origin);
        }
      } else if (payload.action !== 'open') {
        if (!cursor.messages || cursor.input) throw new Error('preparation not ready');
        if (payload.action !== 'next' && cursor.output) throw new Error('preparation output not drained');
        if (payload.action === 'paths') {
          const msg = cursor.messages[payload.index];
          if (!msg) throw new Error('invalid preparation message index');
          cursor.paths = { index: payload.index, values: preparationImagePaths(msg) };
          cursor.output = ingestTokenPages(cursor.paths.values);
        } else if (payload.action === 'replace') {
          if (!cursor.paths || cursor.paths.index !== payload.index || new Set(payload.urls.map(u => u[0])).size !== payload.urls.length || payload.urls.some(u => cursor.paths!.values[u[0]] === undefined)) throw new Error('invalid preparation replacements');
          replacePreparationImageLinks(cursor.messages[payload.index], new Map(payload.urls.map(([index, url]) => [cursor.paths!.values[index], url])));
          cursor.paths = undefined;
        } else if (payload.action === 'images') {
          if (!cursor.messages[payload.index]) throw new Error('invalid preparation message index');
          cursor.imageIndex = payload.index;
          cursor.input = new IngestAssembler();
        } else if (payload.action === 'finish') {
          const messages = cursor.messages.map(finishPreparationMessage);
          const bytes = messages.map(msg => Buffer.byteLength(JSON.stringify(msg)));
          cursor.output = ingestTokenPages({ messages, bytes });
        } else if (payload.action === 'next' && !cursor.output) throw new Error('preparation has no output');
        if (cursor.output) {
          const page = await cursor.output.next();
          done = !!page.done;
          tokens = page.done ? [] : page.value;
          if (page.done) cursor.output = undefined;
        }
      }
      cursor.remaining -= this.now() - started;
      if (cursor.remaining <= 0 || this.now() >= cursor.expires || payload.action !== 'close' && this.cursors.get(key) !== cursor) throw new Error('preparation expired');
      return { cursor: key, generation: cursor.generation, sequence: cursor.sequence++, tokens, done, rss: process.memoryUsage().rss, computeRemainingMs: cursor.remaining };
    } catch (error) {
      await this.remove(key);
      throw error;
    } finally { cursor.busy = false; }
  }
}
