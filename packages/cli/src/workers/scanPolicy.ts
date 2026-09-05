import path from 'node:path';
import { watchDirFilter, watchFilter, CLAUDE_UUID_RE } from '../syncScope.js';
import { isVaultPathIgnored, normalizeVaultPath } from '../vault/vaultScope.js';
import type { ScanPolicy } from './scanTypes.js';
export function scanPredicates(root: string, policy: ScanPolicy) {
  const vault = (rel: string) => { const norm = normalizeVaultPath(rel); return norm !== null && !isVaultPathIgnored(root, norm); };
  const dirFilter = (rel: string): boolean => {
    const d = rel.split(path.sep);
    switch (policy.dirs) {
      case 'claudeIndex': return d.length <= 2 || (d.length === 3 && d[2] === 'subagents') || (d.length === 4 && d[3] === 'workflows') || d.length === 5;
      case 'claudeWatch': return watchDirFilter(rel);
      case 'gemini': return d.length === 1 || d.length === 2 && d[1] === 'chats';
      case 'codexWatch': return d.length <= 3 && d.every((s,i) => (i ? /^\d{2}$/ : /^\d{4}$/).test(s));
      case 'grokWatch': return d.length === 1 || d.length === 2 && CLAUDE_UUID_RE.test(d[1]);
      case 'cursor': return d.length === 1 || d.length <= 3 && d[1] === 'agent-transcripts';
      case 'vault': return vault(rel);
      default: return true;
    }
  };
  const fileFilter = (rel: string): boolean => {
    const d = rel.split(path.sep), base = path.basename(rel);
    switch (policy.files) {
      case 'jsonl': return rel.endsWith('.jsonl');
      case 'claudeIndex': return rel.endsWith('.jsonl') && d.length !== 5;
      case 'geminiIndex': return rel.endsWith('.json') && d.length === 3;
      case 'piIndex': return d.length === 2;
      case 'grokIndex': return d.length === 3 && base === 'updates.jsonl';
      case 'claudeWatch': return watchFilter(rel);
      case 'geminiWatch': return rel.endsWith('.json') && rel.split(/[\\/]/).includes('chats');
      case 'grokWatch': return /[\\/]updates\.jsonl$/.test(rel);
      case 'cursor': return rel.endsWith('.txt') && (rel.includes(`agent-transcripts${path.sep}`) || rel.includes('agent-transcripts/'));
      case 'cursorStale': return rel.endsWith('.txt') && rel.includes(`${path.sep}agent-transcripts${path.sep}`);
      case 'cursorDb': return /state\.vscdb(-wal)?$/.test(rel);
      case 'reconciliation': return base.endsWith('.jsonl') && !base.startsWith('agent-');
      case 'plan': return rel.includes(path.sep) && rel.endsWith('.jsonl') && !rel.includes('sessions-index');
      case 'vault': return vault(rel);
      default: return true;
    }
  };
  return { dirFilter, fileFilter };
}
