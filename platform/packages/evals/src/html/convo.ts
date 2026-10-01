// A conversation on a page: the cast, then the feed with day headers and,
// when a freeze is being shown, the cut.

import type { Conversation } from '../model';
import { esc, shell } from './page';
import { lanesOf, messageCounts, renderCast, renderChips, renderFeed } from './story';

export function renderConversationSection(c: Conversation, opts: { focusId?: string | null; group?: string } = {}): string {
  const group = opts.group ?? `convo-${c.subject.id}`;
  return [
    `<h2>Who is in it</h2>`,
    renderCast(c.participants, messageCounts(c.messages)),
    `<h2>What was said</h2>`,
    renderChips(group, lanesOf(c.messages)),
    renderFeed(c.messages, c.participants, null, group, { focusId: opts.focusId, dayHeaders: true }),
  ].join('\n');
}

export function renderConversationPage(c: Conversation, opts: { focusId?: string | null } = {}): string {
  const body = `<div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap"><h1>${esc(c.subject.title)}</h1><span class="tag">${esc(c.subject.kind)} · ${esc(c.subject.id.slice(0, 8))}</span><span class="tag">${c.total} messages</span></div>${c.subject.subtitle ? `<p class="lede">${esc(c.subject.subtitle)}</p>` : ''}${renderConversationSection(c, opts)}`;
  return shell(c.subject.title, body, { kicker: c.subject.title });
}
