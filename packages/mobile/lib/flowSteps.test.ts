import { describe, expect, test } from 'bun:test';
import { foldFlow } from '@codecast/shared/contracts/flowPool';
import { appPool, flowBySlug } from '@codecast/web/lib/line/flowPool';
import { flowSteps } from './flowSteps';

describe('flowSteps', () => {
  test('numbers the main path, sets off side routes, and names loops and ends', () => {
    const flow = foldFlow(
      [
        { id: 'start', label: 'Start', type: 'start' },
        { id: 'check', label: 'Check', type: 'command' },
        { id: 'review', label: 'Review', type: 'agent' },
        { id: 'fix', label: 'Fix', type: 'agent', backend: 'subject' },
        { id: 'land', label: 'Land', type: 'human' },
        { id: 'done', label: 'Shipped', type: 'exit' },
        { id: 'stop', label: 'Stopped', type: 'exit' },
      ],
      [
        { from: 'start', to: 'check' },
        { from: 'check', to: 'review', condition: 'outcome=success' },
        { from: 'check', to: 'fix', condition: 'outcome=failure' },
        { from: 'review', to: 'land', condition: 'outcome=success' },
        { from: 'review', to: 'fix', label: 'Changes' },
        { from: 'fix', to: 'check' },
        { from: 'land', to: 'done', label: '[a] Approve' },
        { from: 'land', to: 'stop', label: '[r] Reject' },
      ],
    );
    const { rows, loose, end } = flowSteps(flow);
    expect(rows.map((r) => [r.station.label, r.mark])).toEqual([['Check', '1'], ['Review', '2'], ['Land', '3']]);
    const fix = rows[0].routes[0];
    expect([fix.when, fix.kind, fix.detour?.station.label]).toEqual(['outcome=failure', 'side', 'Fix']);
    expect(fix.detour?.routes).toEqual([{ when: null, to: 'Check', toId: 'check', kind: 'back' }]);
    expect(rows[1].routes.map((r) => [r.when, r.kind, !!r.detour])).toEqual([['Changes', 'side', false]]);
    expect(rows[2].routes.map((r) => [r.when, r.kind])).toEqual([['Approve', 'end'], ['Reject', 'end']]);
    expect([loose, end]).toEqual([[], null]);
  });

  test('letters the branches of a fan-out and goes on at the join', () => {
    const flow = foldFlow(
      [
        { id: 'start', label: 'Start', type: 'start' },
        { id: 'fan', label: 'Both', type: 'parallel_fanout' },
        { id: 'a', label: 'Lint', type: 'command' },
        { id: 'b', label: 'Test', type: 'command' },
        { id: 'join', label: 'Join', type: 'parallel_fanin' },
        { id: 'end', label: 'Done', type: 'exit' },
      ],
      [
        { from: 'start', to: 'fan' }, { from: 'fan', to: 'a' }, { from: 'fan', to: 'b' },
        { from: 'a', to: 'join' }, { from: 'b', to: 'join' }, { from: 'join', to: 'end' },
      ],
    );
    const { rows, end } = flowSteps(flow);
    expect(rows.map((r) => [r.station.label, r.mark, r.branch, r.routes.length])).toEqual([
      ['Both', '1', false, 0], ['Lint', '1a', true, 0], ['Test', '1b', true, 0], ['Join', '2', false, 0],
    ]);
    expect(end).toBe('Done');
  });

  test('every shipped flow lists each station once', () => {
    for (const f of appPool([])) {
      const { rows, loose } = flowSteps(f);
      const ids = [...rows, ...loose].flatMap(function walk(r): string[] { return [r.station.id, ...r.routes.flatMap((x) => (x.detour ? walk(x.detour) : []))]; });
      expect(ids.sort()).toEqual(f.stations.map((s) => s.id).sort());
    }
    expect(flowBySlug(appPool([]), 'change')).toBeTruthy();
  });
});
