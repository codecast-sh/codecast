import { beginMessagePreparation, finishPreparationMessage, preparationImagePaths, replacePreparationImageLinks, validResolvedPreparationImage, type PreparationImage, type PreparationMessage } from '../messagePreparation.js';
import { validatePreparationInput, validatePreparationImage } from '../messagePreparationValidation.js';
import { IngestAssembler, ingestTokenPages } from './ingestTransport.js';
import { PREPARATION_COMPUTE_MS, PREPARATION_LIFETIME_MS, PREPARATION_MAX_CURSORS, type PreparationPage, type PreparationPayload } from './preparationTypes.js';
import { INGEST_MAX_BYTES, type IngestToken } from './ingestTypes.js';

type Cursor = {
  generation: string;
  sequence: number;
  origin: 'transcript' | 'service';
  input?: IngestAssembler;
  imageIndex?: number;
  messages?: PreparationMessage[];
  heldBytes: number;
  unresolvedImages: Set<number>;
  paths?: { index: number; values: string[] };
  output?: AsyncGenerator<IngestToken[]>;
  busy: boolean;
  expires: number;
  remaining: number;
  transferDeadline?: number;
  timer: ReturnType<typeof setTimeout>;
};

export class PreparationCursors {
  private cursors = new Map<string, Cursor>();
  constructor(private readonly now = () => performance.now(), private readonly timers = { set: setTimeout, clear: clearTimeout }) {}
  get size() { return this.cursors.size; }
  private async remove(key: string) {
    const cursor = this.cursors.get(key);
    if (!cursor) return;
    this.cursors.delete(key);
    this.timers.clear(cursor.timer);
    await cursor.output?.return(undefined);
  }
  async request(payload: PreparationPayload, id: string): Promise<PreparationPage> {
    const started = this.now(), key = payload.action === 'open' ? id : payload.cursor;
    if (payload.action === 'open') {
      if (this.cursors.size >= PREPARATION_MAX_CURSORS || this.cursors.has(key)) throw new Error('preparation busy');
      const timer = this.timers.set(() => { void this.remove(key); }, PREPARATION_LIFETIME_MS);
      timer.unref();
      this.cursors.set(key, { generation: payload.generation, sequence: 0, origin: payload.origin, input: new IngestAssembler(), heldBytes: 0, unresolvedImages: new Set(), busy: false, expires: started + PREPARATION_LIFETIME_MS, remaining: PREPARATION_COMPUTE_MS, transferDeadline: started + PREPARATION_COMPUTE_MS, timer });
    }
    const cursor = this.cursors.get(key);
    if (!cursor || cursor.busy || cursor.generation !== payload.generation || payload.action !== 'open' && payload.sequence !== cursor.sequence) throw new Error('invalid preparation cursor');
    cursor.busy = true;
    try {
      if (started >= cursor.expires || cursor.remaining <= 0 || cursor.transferDeadline !== undefined && started >= cursor.transferDeadline) throw new Error('preparation expired');
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
          if (value.length > 10) throw new Error('invalid prepared images');
          for (const image of value) validatePreparationImage(image);
          if (value.some(img => !validResolvedPreparationImage(img))) throw new Error('invalid prepared images');
          cursor.messages![cursor.imageIndex].images = value as PreparationImage[];
          cursor.unresolvedImages.delete(cursor.imageIndex);
          cursor.imageIndex = undefined;
        } else {
          if (cursor.messages) throw new Error('invalid preparation messages');
          const messages = await validatePreparationInput(value, cursor.origin, () => {
            if (this.cursors.get(key) !== cursor || this.now() >= Math.min(cursor.expires, cursor.transferDeadline ?? cursor.expires)) throw new Error('preparation expired');
          });
          cursor.messages = beginMessagePreparation(messages, cursor.origin);
          cursor.messages.forEach((msg, index) => {
            if (msg.images?.slice(0, 10).some(img => !img.storageId)) cursor.unresolvedImages.add(index);
          });
        }
        cursor.heldBytes = Buffer.byteLength(JSON.stringify(cursor.messages));
        if (cursor.heldBytes > INGEST_MAX_BYTES) throw new Error('preparation state resource limit');
      } else if (payload.action !== 'open') {
        if (!cursor.messages || cursor.input) throw new Error('preparation not ready');
        if (payload.action !== 'next' && cursor.output) throw new Error('preparation output not drained');
        if (payload.action === 'paths') {
          const msg = cursor.messages[payload.index];
          if (!msg) throw new Error('invalid preparation message index');
          cursor.paths = { index: payload.index, values: preparationImagePaths(msg) };
          cursor.output = ingestTokenPages(cursor.paths.values);
          cursor.transferDeadline = started + cursor.remaining;
        } else if (payload.action === 'replace') {
          if (!cursor.paths || cursor.paths.index !== payload.index || new Set(payload.urls.map(u => u[0])).size !== payload.urls.length || payload.urls.some(u => cursor.paths!.values[u[0]] === undefined)) throw new Error('invalid preparation replacements');
          replacePreparationImageLinks(cursor.messages[payload.index], new Map(payload.urls.map(([index, url]) => [cursor.paths!.values[index], url])));
          cursor.heldBytes = Buffer.byteLength(JSON.stringify(cursor.messages));
          if (cursor.heldBytes > INGEST_MAX_BYTES) throw new Error('preparation state resource limit');
          cursor.paths = undefined;
        } else if (payload.action === 'images') {
          if (!cursor.messages[payload.index]) throw new Error('invalid preparation message index');
          cursor.imageIndex = payload.index;
          cursor.input = new IngestAssembler();
          cursor.transferDeadline = started + cursor.remaining;
        } else if (payload.action === 'finish') {
          if (cursor.unresolvedImages.size) throw new Error('preparation images unresolved');
          const messages = cursor.messages.map(finishPreparationMessage);
          const bytes = messages.map(msg => Buffer.byteLength(JSON.stringify(msg)));
          cursor.output = ingestTokenPages({ messages, bytes });
          cursor.transferDeadline = started + cursor.remaining;
        } else if (payload.action === 'next' && !cursor.output) throw new Error('preparation has no output');
        if (cursor.output) {
          const page = await cursor.output.next();
          done = !!page.done;
          tokens = page.done ? [] : page.value;
          if (page.done) cursor.output = undefined;
        }
      }
      cursor.remaining -= this.now() - started;
      if (cursor.transferDeadline !== undefined) cursor.remaining = Math.min(cursor.remaining, cursor.transferDeadline - this.now());
      if (cursor.remaining <= 0 || this.now() >= cursor.expires || payload.action !== 'close' && this.cursors.get(key) !== cursor) throw new Error('preparation expired');
      if (!cursor.input && !cursor.output) cursor.transferDeadline = undefined;
      if (payload.action !== 'close') {
        this.timers.clear(cursor.timer);
        cursor.timer = this.timers.set(() => { void this.remove(key); }, Math.max(1, Math.min(cursor.expires, cursor.transferDeadline ?? cursor.expires) - this.now()));
        cursor.timer.unref();
      }
      return { cursor: key, generation: cursor.generation, sequence: cursor.sequence++, tokens, done, rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * (process.versions.bun ? 1 : 1024), computeRemainingMs: cursor.remaining };
    } catch (error) {
      await this.remove(key);
      throw error;
    } finally { cursor.busy = false; }
  }
}
