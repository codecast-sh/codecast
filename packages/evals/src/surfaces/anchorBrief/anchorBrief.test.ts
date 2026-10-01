import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrapMessage } from '../../../../convex/convex/anchors';
import type { CliReadMessage } from '../../adapters/convo';
import { readFixture } from '../../adapters/resolver';
import { runSnapshot } from '../../commands/snapshot';
import impl, { captureAnchorBrief, openingOf, replyAfter, type AnchorBriefSnap } from './index';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evals-anchor-'));
  process.env.CODECAST_EVALS_HOME = home;
});
afterEach(() => {
  delete process.env.CODECAST_EVALS_HOME;
  rmSync(home, { recursive: true, force: true });
});

const fixtureSnap = (kase: string) => readFixture('anchor-brief', kase).snapshot as AnchorBriefSnap;

describe('the opening', () => {
  test("fixtures render the tree's builders: a role's opening, and the workspace agent's", () => {
    const role = fixtureSnap('docs-role-opening');
    expect(openingOf(role)).toBe(bootstrapMessage(role.facts!));
    expect(openingOf(role)).toContain('You are the **Docs lead** (@docs) in Fernhill. You report to Mara.');
    const anchor = fixtureSnap('team-anchor-opening');
    expect(openingOf(anchor)).toContain("the **team** workspace's standing agent for Fernhill");
  });

  test('a real freeze replays the opening prod sent', () => {
    expect(openingOf({ captured_at: 'x', opening: { text: 'You are the lead.', at: 'y', line: 3 } })).toBe('You are the lead.');
  });
});

const msg = (line: number, role: string, content: string, extra: Partial<CliReadMessage> = {}): CliReadMessage => ({ line, role, content, timestamp: new Date(Date.UTC(2026, 8, 20, 9, line)).toISOString(), ...extra });

describe('capture', () => {
  const session = [
    msg(12, 'user', 'You are the **Docs lead** (@docs) in Fernhill.'),
    msg(13, 'assistant', ''),
    msg(14, 'user', '', { tool_results: [{ content: 'brief…' }] }),
    msg(15, 'assistant', 'Hello: Docs lead, online.'),
    msg(16, 'user', 'thanks, check the billing page next'),
    msg(17, 'assistant', 'On it.'),
  ];
  const ctx = { readConversation: async (_ref: string, o?: { from?: number }) => ({ conversation: { id: 'conv-docs-full', title: 'Docs lead' }, messages: session.filter((m) => m.line >= (o?.from ?? 1)) }) };
  const world = () => runSnapshot('anchor-brief', ['--session', 'jx7dcs1', '--team', 'Fernhill', '--role', 'docs', '--name', 'w1'], (argv) => ({ out: `served ${argv.join(' ')}`, code: 0 }));

  test("freezes the opening at its line, prod's answer up to the next typed message, and the world captured for the session", async () => {
    world();
    const c = await captureAnchorBrief('jx7dcs1:12', ctx);
    const snap = c.snapshot as AnchorBriefSnap;
    expect(snap).toMatchObject({ served: 'anchor-brief/w1', opening: { text: session[0]!.content, line: 12 } });
    expect(snap.reply!.map((m) => m.content)).toEqual(['Hello: Docs lead, online.']);
    expect(c.asOf).toBe(snap.captured_at);
    expect(c.meta).toMatchObject({ conversation_id: 'conv-docs-full', workspace: 'Fernhill' });
    expect(impl.productionReply!(snap)!.messages.map((m) => m.text)).toEqual(['Hello: Docs lead, online.']);
  });

  test('refuses a line that is not an opening, and a session with no captured world', async () => {
    await expect(captureAnchorBrief('jx7dcs1:12', ctx)).rejects.toThrow('capture its world first');
    world();
    await expect(captureAnchorBrief('jx7dcs1:15', ctx)).rejects.toThrow("name the opening's line");
  });

  test('replyAfter stops at the next message a person typed, not at a tool result', () => {
    expect(replyAfter(session.slice(1)).map((m) => m.line)).toEqual([15]);
  });
});
