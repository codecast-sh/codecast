// A freeze on a page: the moment with the cut, what production said next,
// and every replay side by side with its verdict, so a prompt change reads
// as a row of replies rather than a number.

import type { Conversation, Freeze, ProductionReply, RunDetail } from '../model';
import { bar, esc, money, shell, verdictPill } from './page';
import { renderConversationSection } from './convo';

export function renderFreezePage(f: Freeze, convo: Conversation | null, production: ProductionReply | null, replays: RunDetail[]): string {
  const out: string[] = [];
  out.push(`<div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap"><h1>${esc(f.name)}</h1><span class="tag">freeze ${esc(f.id.slice(0, 8))}</span><span class="tag">as of ${esc(f.asOf.replace('T', ' ').slice(0, 16))}</span>${f.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`);
  out.push(`<p class="lede">${esc(f.subject.title)} · anchored on ${esc(f.anchor.kind)} ${esc(f.anchor.id.slice(0, 8))}${f.trigger ? ` · woken by ${esc(f.trigger.type)}` : ''}.${f.notes ? ` ${esc(f.notes)}` : ''}</p>`);
  out.push(`<div class="card"><div class="k" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)">Judge criteria</div><p style="margin:6px 0 0">${f.judge ? esc(f.judge) : '<span style="color:var(--warn)">Unjudged. Every replay reports a vacuous pass until criteria are set.</span>'}</p></div>`);

  const card = (title: string, verdict: { pass: boolean; score: number; reasoning?: string | null } | null, texts: Array<{ to: string | null; text: string }>, extra: string): string =>
    `<div class="card" style="border-left:3px solid ${verdict ? (verdict.pass ? 'var(--pass)' : 'var(--fail)') : 'var(--line-2)'}"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><strong>${esc(title)}</strong>${verdict ? verdictPill(verdict.pass ? 'pass' : 'fail', verdict.score) : '<span class="verdict v-unscored">UNJUDGED</span>'}<span class="mono" style="margin-left:auto;color:var(--faint);font-size:12px">${extra}</span></div>${texts.length ? texts.map((t) => `<div class="mono" style="font-size:11px;color:var(--faint);margin-top:10px">→ ${esc(t.to ?? '?')}</div><div style="white-space:pre-wrap;font-size:14.5px">${esc(t.text)}</div>`).join('') : '<p style="color:var(--faint);margin-top:10px">said nothing</p>'}${verdict?.reasoning ? `<blockquote>${esc(verdict.reasoning)}</blockquote>` : ''}</div>`;

  out.push('<h2>The replies, side by side</h2>');
  const cards: string[] = [];
  if (production) cards.push(card('production', production.verdict ?? null, production.messages.map((m) => ({ to: m.to ?? null, text: m.text })), 'what actually went out'));
  for (const r of replays) {
    const judged = r.verdict?.checks.find((c) => c.id === 'criteria' || c.id === 'judge') ?? null;
    cards.push(card(`replay ${r.id.slice(-24)}`, r.verdict ? { pass: r.verdict.pass, score: r.verdict.score, reasoning: judged?.reasoning ?? null } : null, r.messages.filter((m) => m.direction === 'out').map((m) => ({ to: m.to ? (r.participants.find((p) => p.id === m.to)?.name ?? m.to) : null, text: m.text })), [r.model, r.notes, money(r.costUsd), r.gatesFailed.length ? `gates: ${r.gatesFailed.join(', ')}` : ''].filter(Boolean).map(esc).join(' · ')));
  }
  out.push(`<div class="side">${cards.join('') || '<div class="card">No replays yet.</div>'}</div>`);

  if (replays.length) {
    out.push('<h2>Checks across replays</h2>');
    const ids = [...new Set(replays.flatMap((r) => r.verdict?.checks.map((c) => c.id) ?? []))];
    out.push(`<table><thead><tr><th>Check</th>${replays.map((r) => `<th class="num">${esc(r.id.slice(-12))}</th>`).join('')}</tr></thead><tbody>${ids.map((id) => `<tr><td><code class="mono">${esc(id)}</code></td>${replays.map((r) => { const c = r.verdict?.checks.find((x) => x.id === id); return `<td class="num">${c ? `${bar(c.score)} ${c.score.toFixed(2)}` : '&mdash;'}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`);
  }

  if (convo) {
    out.push('<h2>The moment</h2>');
    out.push('<p class="lede">The conversation as the assistant could see it, cut where the marker is. A replay starts from the message above the cut and sees nothing below it.</p>');
    out.push(renderConversationSection(convo, { focusId: f.anchor.kind === 'message' ? f.anchor.id : null, group: `freeze-${f.id}` }));
  }
  return shell(f.name, out.join('\n'), { kicker: `freeze ${f.id.slice(0, 8)}` });
}
