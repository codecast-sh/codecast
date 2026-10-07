/**
 * A group-chat agent over the in-memory store, end to end, with no network:
 * the summaries and the agent's turns come from @platform/agent's faux
 * provider, which answers like a model would but deterministically.
 *
 *   bun examples/group-chat/main.ts
 *
 * Five people in a community garden chat with an assistant, one-to-one and in
 * the group, for about two hundred days. The script compresses the history,
 * then shows the reads an agent gets: the cover, a zoom in, a zoom out, a
 * focus on one month, the same cover at two budgets, and finally a run in
 * which the model calls read_history itself.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, type Context } from '@mariozechner/pi-ai';
import { runAssistant } from '@platform/agent';

import { historySection, historyTools, memorySection, runScopedAgent } from '../../src/agent';
import { bucketKinds, createHistory, fixedClock, promptSummarizer, scopedViewer, type HistoryView, type Scope } from '../../src/index';
import { memoryRunStore, memoryStore } from '../../src/stores/memory';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 2, 1); // March 1 2026
const DAYS = 200;
const P = 'garden-club';

const people = ['Ines', 'Tomas', 'Wren', 'Kofi', 'Mei'];
const group: Scope = { type: 'group', id: 'garden-club' };
const person = (name: string): Scope => ({ type: 'person', id: name.toLowerCase() });

// A small deterministic random, so every run prints the same output.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

const crops = ['tomatoes', 'garlic', 'kale', 'squash', 'beans', 'basil', 'peppers', 'strawberries'];
const groupTopics = [
  (who: string) => `${who} asked who can water the north beds this weekend`,
  (who: string) => `${who} posted a photo of the first ${pick(crops)}`,
  (who: string) => `${who} proposed moving the work day to Sunday`,
  (who: string) => `${who} reported aphids on the ${pick(crops)}`,
  (who: string) => `${who} offered spare ${pick(crops)} seedlings`,
  (who: string) => `${who} asked whether the compost is ready to spread`,
];
const privateTopics = [
  (who: string) => `${who} asked for a reminder before their watering shift`,
  (who: string) => `${who} said they will be away for two weeks`,
  (who: string) => `${who} wants a plot closer to the shed next season`,
  (who: string) => `${who} asked how to save ${pick(crops)} seeds`,
];

async function main() {
  const clock = fixedClock(START + DAYS * DAY + 9 * 60 * 60 * 1000);
  const store = memoryStore({ clock });

  // The faux model plays the summarizer: it reads the lines it is given and
  // writes a short paragraph naming only what they contain.
  const faux = registerFauxProvider({ models: [{ id: 'claude-sonnet-5-5' }] });
  const summarize = (context: Context) => {
    const user = String((context.messages[0] as { content: unknown }).content);
    if (user.startsWith('[Earlier:')) {
      const ranges = user.split('\n').filter((l) => l.startsWith('[Earlier: ') || l.startsWith('[Later: ')).map((l) => l.slice(l.indexOf(': ') + 2, -1));
      const names = people.filter((n) => user.includes(n));
      return fauxAssistantMessage(`From ${ranges[0].split(' to ')[0]} to ${ranges[1].split(' to ').pop()}, ${names.join(', ') || 'nobody'} kept the garden going.`);
    }
    const lines = user.split('\n');
    const first = lines[0].slice(lines[0].indexOf(': ') + 2);
    const names = people.filter((n) => user.includes(n));
    return fauxAssistantMessage(`${lines.length} messages; ${names.join(', ')} took part. It began when ${first}.`);
  };
  // One queue for every summary call: compression runs several scopes at once.
  faux.setResponses(Array.from({ length: 5000 }, () => summarize));
  const summarizer = promptSummarizer(async (system, user) => {
    const out = await runAssistant({ model: faux.getModel(), system, history: [{ role: 'user', content: user, timestamp: 0 }], ceilingUsd: 1, deadlineMs: 10_000 });
    return out.messages.map((m) => m.content ?? '').join('');
  });

  const history = createHistory({
    store,
    clock,
    summarizer,
    scopes: [{ type: 'person' }, { type: 'group' }],
    // Reactions are noise one at a time: they fold into one line an hour.
    collapse: { aggregateKey: bucketKinds(['reaction']) },
  });

  // About two hundred days: most days the group talks, some days someone
  // writes to the assistant privately, and the assistant answers both.
  let logged = 0;
  for (let d = 0; d < DAYS; d++) {
    const day = START + d * DAY;
    const talk = 2 + Math.floor(rand() * 4);
    for (let i = 0; i < talk; i++) {
      const at = day + (8 + i * 2) * 60 * 60 * 1000 + Math.floor(rand() * 3_600_000);
      const who = pick(people);
      await store.append({ scope: group, partition: P, kind: 'message_in', summary: pick(groupTopics)(who), actor: { name: who }, at: store.cursorAt(at) });
      await store.append({ scope: group, partition: P, kind: 'message_out', summary: `assistant replied to ${who} in the group`, at: store.cursorAt(at + 60_000) });
      for (let r = 0; r < 3; r++) await store.append({ scope: group, partition: P, kind: 'reaction', summary: `${pick(people)} reacted`, at: store.cursorAt(at + 120_000 + r * 1000) });
      logged += 5;
    }
    if (rand() < 0.5) {
      const who = pick(people);
      const at = day + 19 * 60 * 60 * 1000;
      await store.append({ scope: person(who), partition: P, kind: 'message_in', summary: pick(privateTopics)(who), actor: { name: who }, at: store.cursorAt(at) });
      await store.append({ scope: person(who), partition: P, kind: 'message_out', summary: `assistant answered ${who}`, at: store.cursorAt(at + 60_000) });
      logged += 2;
    }
  }
  await store.write({ agentId: 'gardener', scope: group, partition: P, header: 'Work days', content: 'The group meets on the first Saturday of the month.', createdAtMs: START });

  const report = await history.compressOnce({ deadlineAt: Date.now() + 10 * 60_000 });
  console.log(`# Seeded ${logged} activities over ${DAYS} days in ${1 + people.length} scopes.`);
  console.log(`# Compressed: ${report.leaves} leaves from ${report.activities} activities, ${report.merged} merged blocks, ${report.failures} failures.\n`);

  const viewer = scopedViewer('gardener', [group, ...people.map(person)], P);
  const show = (title: string, view: HistoryView, maxLines = 60) => {
    const lines = view.text.split('\n');
    console.log(`==== ${title}`);
    console.log(`(${view.stats.raw} raw lines, ${view.stats.recentBlocks + view.stats.olderBlocks} blocks, ~${view.stats.tokens} tokens)`);
    console.log(lines.slice(0, maxLines).join('\n'));
    if (lines.length > maxLines) console.log(`… ${lines.length - maxLines} more lines`);
    console.log();
  };
  const blockHandles = (view: HistoryView) => view.handles.filter((h) => h.kind === 'block').sort((a, b) => a.range[0] - b.range[0]);

  // 1. The cover: raw lines since the newest summary, then the tree back to
  // day one. A one-day raw window keeps the printout short (the default is two
  // weeks): raw lines begin right after the newest summary older than a day.
  const budget = { coverLines: 12, rawWindow: { kind: 'age' as const, ms: DAY } };
  const cover = await history.view({ select: { scope: group }, viewer, budget });
  show('1. The cover of the group chat (12 summary lines; raw lines since the newest summary)', cover, 80);

  // 2. Zoom in: open the oldest block into the two it was written from.
  const oldest = blockHandles(cover)[0].handle;
  show(`2. Zoom in: open ${oldest}`, await history.open(oldest, { viewer }));

  // 3. Zoom out: from a single leaf to the block one level up. A missing parent is built on demand.
  const leaf = blockHandles(cover).find((h) => h.level === 0)!.handle;
  show(`3. Zoom out from the leaf ${leaf}`, await history.zoomOut(leaf, { viewer, build: true }));

  // 4. Focus: May at six lines, finest at the end of the month.
  show('4. Focus on May 2026 at 6 lines', await history.focus({ select: { scope: group }, viewer, from: Date.UTC(2026, 4, 1), to: Date.UTC(2026, 5, 1), budget: { coverLines: 6 } }));

  // 5. Two budgets over the same history: both reach day one, the narrow one in fewer, coarser blocks.
  for (const coverLines of [24, 4]) {
    const view = await history.view({ select: { scope: group }, viewer, budget: { coverLines } });
    const blocks = blockHandles(view);
    const summaryTokens = view.sections.filter((x) => x.title !== '## Recent Activity').flatMap((x) => x.lines).reduce((n, l) => n + Math.ceil(l.text.length / 4), 0);
    console.log(`==== 5. Budget of ${coverLines} lines: ${blocks.length} blocks (~${summaryTokens} tokens of summaries), reaching back to ${new Date(blocks[0].range[0]).toISOString().slice(0, 10)}`);
    console.log(`leaves per block, oldest to newest: ${blocks.map((h) => 2 ** (h.level ?? 0)).join(' ')}\n`);
  }

  // 6. An agent run: the model reads the cover in its system prompt, zooms in
  // with read_history, then answers. The faux model scripts those two turns.
  const run = { runId: 'run-1', agentId: 'gardener', scope: group, partition: P, reason: 'weekly_digest' };
  faux.setResponses([
    () => fauxAssistantMessage([fauxText('Checking the oldest stretch first.'), fauxToolCall('read_history', { item: oldest }, { id: 'call_1' })], { stopReason: 'toolUse' }),
    (context) => {
      const result = context.messages[context.messages.length - 1] as { content: Array<{ text?: string }> };
      const text = result.content.map((c) => c.text ?? '').join('');
      return fauxAssistantMessage(`Digest: the group has been active since March; the opened stretch shows ${text.split('[/block:').length - 1} summaries.`);
    },
  ]);
  const runs = memoryRunStore();
  const result = await runScopedAgent({
    run,
    profile: { id: 'gardener', history: budget },
    sections: [{ key: 'identity', tier: 'stable', render: () => 'You help a community garden group coordinate.' }, memorySection(store, { clock }), historySection(history, { viewer })],
    tools: historyTools(history, { run, viewer, profile: { id: 'gardener', history: budget }, clock }),
    model: faux.getModel(),
    ceilingUsd: 1,
    deadlineMs: 30_000,
    runs,
    input: 'Write this week’s digest for the group.',
    clock,
  });
  console.log('==== 6. An agent run that zooms by itself');
  console.log(`context sections (tokens): ${JSON.stringify(result.context.sizes)}`);
  for (const m of result.messages) {
    if (m.role === 'assistant' && m.content) console.log(`assistant: ${m.content}`);
    if (m.tool_calls?.length) console.log(`assistant calls ${m.tool_calls.map((c) => `${c.name}(${typeof c.input === 'string' ? c.input : JSON.stringify(c.input)})`).join(', ')}`);
    if (m.tool_results?.length) console.log(`tool result: ${m.tool_results[0].content.split('\n')[0]} …`);
  }
  console.log(`run recorded: ${runs.runs.get('run-1')!.steps.length} rows, ended ${runs.runs.get('run-1')!.end?.reason}`);
  faux.unregister();
}

await main();
