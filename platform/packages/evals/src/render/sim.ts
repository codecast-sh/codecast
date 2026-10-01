// The scenario library and the streaming line a running simulation prints.

import { renderNext, renderTable, type RenderOpts } from '@platform/cli-kit/render';

import type { ScenarioInfo } from '../model';
import { makePalette } from './common';

export function renderScenarios(rows: ScenarioInfo[], o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const lines = [`${p.bold(p.cyan('Scenarios'))}  ${p.dim(`${rows.length} in this tree`)}`, ''];
  lines.push(
    ...renderTable(
      rows,
      [
        { header: 'id', width: 18, value: (r) => r.id, style: () => p.bold },
        { header: 'title', width: 32, value: (r) => r.title },
        { header: 'hunts', value: (r) => r.hunts ?? '' , style: () => p.dim },
      ],
      p,
      o.width,
    ),
  );
  lines.push('', ...renderNext([[`${cli} sim run ${rows[0]?.id ?? '<id>'} --dry`, 'prove the wiring, spend nothing'], [`${cli} sim run ${rows[0]?.id ?? '<id>'} --seed 11`, 'the real thing, then the page'], [`${cli} sim sweep --dry`, 'every scenario, one report']], p));
  return lines.join('\n');
}
