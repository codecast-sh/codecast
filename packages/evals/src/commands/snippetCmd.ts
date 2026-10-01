import type { Command } from 'commander';
import { fmt, icons } from '@platform/cli-kit/colors';

import { AGENTS_MD } from '../paths';
import { EVALS_SNIPPET, installSnippet, removeSnippet, snippetInstalled } from '../snippet';

export function registerSnippet(program: Command): void {
  const snippet = program.command('snippet').description('the one-page reference agents read (stamped into AGENTS.md)');
  snippet
    .command('install')
    .description(`write or refresh the section in ${AGENTS_MD} (--file for another)`)
    .option('--file <path>', 'the instruction file to stamp')
    .action((flags) => {
      const r = installSnippet(flags.file);
      console.log(`${fmt.success(icons.check)} ${r.installed ? 'Installed' : r.updated ? 'Updated' : 'Already current'}: ${fmt.path(flags.file ?? AGENTS_MD)}`);
    });
  snippet
    .command('remove')
    .option('--file <path>', 'the instruction file')
    .description('take the section out')
    .action((flags) => {
      console.log(removeSnippet(flags.file) ? 'Removed.' : 'Nothing to remove.');
    });
  snippet.command('show').description('print the section').action(() => {
    process.stdout.write(EVALS_SNIPPET.trimStart());
  });
  snippet
    .command('status')
    .option('--file <path>', 'the instruction file')
    .description('whether the stamped section matches this build')
    .action((flags) => {
      const s = snippetInstalled(flags.file);
      console.log(s === 'current' ? `${fmt.success(icons.check)} Installed and current` : s === 'stale' ? fmt.warning('Installed but out of date; run ./evals snippet install') : `Not installed. Run ${fmt.cmd('./evals snippet install')}.`);
    });
}
