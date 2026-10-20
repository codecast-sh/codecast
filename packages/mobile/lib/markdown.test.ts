import { describe, expect, test } from 'bun:test';
import { parseMarkdown, plainText, planTable } from './markdown';
import { renderGalleryMessages } from '@codecast/web/lib/renderGallery';

const CHAR = 7.8; // 13px JetBrains Mono
const PAD = 8;
const PHONE = 340;

function tableRows(md: string): string[][] {
  const table = parseMarkdown(md).children.find((n) => n.type === 'table');
  if (!table || table.type !== 'table') throw new Error('no table');
  return table.children.map((row) => row.children.map((cell) => plainText(cell)));
}

describe('parseMarkdown', () => {
  test('a table keeps empty cells and escaped pipes in their columns', () => {
    const rows = tableRows('| a | b | c |\n|---|---|---|\n| 1 |  | x \\| y |');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '', 'x | y']]);
  });

  test('a list item holds its continuation paragraph and nested list', () => {
    const tree = parseMarkdown('- one\n\n  more of one\n  - inner\n- two');
    const list = tree.children[0];
    expect(list.type).toBe('list');
    if (list.type !== 'list') return;
    expect(list.children).toHaveLength(2);
    expect(list.children[0].children.map((c) => c.type)).toEqual(['paragraph', 'paragraph', 'list']);
  });

  test('task items, strikethrough and tilde fences parse', () => {
    const tree = parseMarkdown('- [x] done\n- [ ] todo\n\n~~gone~~\n\n~~~ts\nconst a = 1\n~~~');
    const list = tree.children[0];
    if (list.type !== 'list') throw new Error('no list');
    expect(list.children.map((i) => i.checked)).toEqual([true, false]);
    expect(tree.children[1].type === 'paragraph' && tree.children[1].children[0].type).toBe('delete');
    expect(tree.children[2]).toMatchObject({ type: 'code', lang: 'ts', value: 'const a = 1' });
  });

  test('bare URLs and ids stay text for the reference scanner', () => {
    const tree = parseMarkdown('see https://codecast.sh and ct-42');
    const p = tree.children[0];
    expect(p.type === 'paragraph' && p.children.map((c) => c.type)).toEqual(['text']);
  });
});

describe('planTable', () => {
  test('a narrow table is a full-width grid', () => {
    const plan = planTable([['Key', 'Value'], ['a', '1'], ['b', '2']], PHONE, CHAR, PAD);
    expect(plan.kind).toBe('grid');
    if (plan.kind !== 'grid') return;
    expect(plan.scroll).toBe(false);
    expect(plan.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(PHONE);
    expect(plan.widths.reduce((a, b) => a + b, 0)).toBeGreaterThan(PHONE - 3);
  });

  test('two columns of prose wrap inside the width', () => {
    const plan = planTable([
      ['Option', 'What happens'],
      ['Rebase', 'Replays your commits on top of main so history stays flat and readable'],
    ], PHONE, CHAR, PAD);
    expect(plan.kind).toBe('grid');
    if (plan.kind !== 'grid') return;
    expect(plan.scroll).toBe(false);
    expect(plan.widths[1]).toBeGreaterThan(plan.widths[0]);
  });

  test('four columns of prose become cards (the pans table)', () => {
    const rows = tableRows([
      '| Session | Pan 1 | Pan 2 | Makes |',
      '|---|---|---|---|',
      '| Butter chicken night | Chicken thighs browned, then simmered in sauce | Basmati rice | 8 servings |',
      '| Meatballs | About 30 meatballs browned, then simmered | Marinara | 6 servings |',
    ].join('\n'));
    expect(planTable(rows, PHONE, CHAR, PAD).kind).toBe('cards');
  });

  test('a wide table of short values scrolls as a grid', () => {
    const rows = [
      ['Run', 'Model', 'p50', 'p90', 'p99', 'errors', 'cost'],
      ['baseline', 'sonnet-5-5', '120ms', '340ms', '900ms', '0', '$0.02'],
      ['candidate', 'haiku-5-5', '118ms', '310ms', '870ms', '1', '$0.01'],
    ];
    const plan = planTable(rows, PHONE, CHAR, PAD);
    expect(plan).toMatchObject({ kind: 'grid', scroll: true });
  });
});

describe('render gallery', () => {
  test('its tables exercise every phone table layout', () => {
    const layouts = new Set<string>();
    for (const row of renderGalleryMessages(0)) {
      if (row.role !== 'assistant') continue;
      for (const node of parseMarkdown(row.content).children) {
        if (node.type !== 'table') continue;
        const plan = planTable(node.children.map((r) => r.children.map((c) => plainText(c))), PHONE, CHAR, PAD);
        layouts.add(plan.kind === 'cards' ? 'cards' : plan.scroll ? 'scroll' : plan.wraps ? 'wrap' : 'grid');
      }
    }
    expect([...layouts].sort()).toEqual(['cards', 'grid', 'scroll', 'wrap']);
  });
});
