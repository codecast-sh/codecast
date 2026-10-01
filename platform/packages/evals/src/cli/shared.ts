// What every command shares: the render options read once from the process,
// the JSON escape hatch, opening a page, and the errors for a source the app
// did not wire.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { renderOpts as baseRenderOpts, type RenderOpts } from '@platform/cli-kit/render';
import { parseSince } from '@platform/cli-kit/text';
import type { Command } from 'commander';

import type { EvalSources } from '../model';

export interface CommonFlags {
  json?: boolean;
  color?: boolean;
  width?: number;
  full?: boolean;
}

export function addCommon(cmd: Command): Command {
  return cmd
    .option('--json', 'machine readable output')
    .option('--no-color', 'plain text (colour is off anyway when piped)')
    .option('--width <n>', 'columns', (v) => Number(v))
    .option('--full', 'show everything, untruncated');
}

export function opts(flags: CommonFlags): RenderOpts & { cli: string } {
  return { ...baseRenderOpts({ color: flags.color, width: flags.width, full: flags.full }), cli: CLI.name };
}

export function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export class UsageError extends Error {}

export function need<K extends keyof EvalSources>(sources: EvalSources, key: K, what: string): NonNullable<EvalSources[K]> {
  const v = sources[key];
  if (!v) throw new UsageError(`${sources.name} has no ${what} wired in this repo (EvalSources.${String(key)} is unset)`);
  return v as NonNullable<EvalSources[K]>;
}

export function since(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const t = parseSince(text);
  if (t === null) throw new UsageError(`--since takes 3d, 48h, 2w or a date, not "${text}"`);
  return t;
}

export function list(text: string | undefined): string[] | undefined {
  return text ? text.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

/** Write a page under the html dir (or the given path) and print where it went; `--open` opens it. */
export function writePage(sources: EvalSources, name: string, html: string, flags: { out?: string; open?: boolean }): string {
  const path = flags.out ? resolve(flags.out) : join(sources.htmlDir ?? join(process.cwd(), '.sim', 'html'), name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  out(path);
  if (flags.open) openPath(path);
  return path;
}

export function openPath(path: string): void {
  if (!existsSync(path)) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [path], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Printing the path is the deliverable; opening it is a courtesy.
  }
}

export function setCli(name: string): void {
  CLI.name = name;
}
export const CLI = { name: 'xrun' };
