import type { Command } from 'commander';

import type { ConvoSubject, EvalSources } from '../model';
import { renderConversationPage } from '../html/convo';
import { renderCandidates, renderConversation, renderInbox, renderMessage, renderSearch, renderWho } from '../render/convo';
import { addCommon, json, list, need, opts, out, since, UsageError, writePage, type CommonFlags } from './shared';

async function resolveSubject(sources: EvalSources, ref: string, flags: CommonFlags): Promise<{ subject: ConvoSubject; focusId?: string | null } | null> {
  const convo = need(sources, 'convo', 'conversation source');
  const r = await convo.resolve(ref);
  if (!r) throw new UsageError(`nothing matches "${ref}": an id or prefix, an address, a name, or a message id`);
  if ('candidates' in r) {
    if (flags.json) json(r.candidates);
    else out(renderCandidates(r.candidates, ref, opts(flags)));
    return null;
  }
  return r;
}

export function registerConvo(program: Command, sources: EvalSources): void {
  const convo = program.command('convo').description('read conversations: inbox, one subject, one message, search');

  addCommon(convo.command('inbox').description('latest inbound, newest first; ! marks what nobody answered'))
    .option('--since <t>', 'window: 48h, 3d, 2w (default 7d)')
    .option('--channel <kind>', 'one rail: imessage, sms, app, email, telegram')
    .option('--unanswered', 'only messages nobody replied to')
    .option('-n, --limit <n>', 'rows', (v) => Number(v), 40)
    .action(async (flags) => {
      const src = need(sources, 'convo', 'conversation source');
      const rows = await src.inbox({ since: since(flags.since ?? '7d'), channel: flags.channel, unanswered: flags.unanswered, limit: flags.limit });
      if (flags.json) return json(rows);
      out(renderInbox(rows, opts(flags)));
    });

  addCommon(convo.command('show <ref>').description('the conversation, oldest to newest; a message id opens it focused there'))
    .option('--around <n>', 'centre on message number n', (v) => Number(v))
    .option('--radius <n>', 'messages either side of --around (default 6)', (v) => Number(v))
    .option('--from <n>', 'first message number', (v) => Number(v))
    .option('--to <n>', 'last message number', (v) => Number(v))
    .option('--last <n>', 'the last n (default 40)', (v) => Number(v))
    .option('--lines <n>', 'body lines per message (default 6)', (v) => Number(v))
    .option('--channel <kinds>', 'only these rails, comma separated')
    .option('--system', 'include runs, decisions and notes between the messages')
    .option('--html', 'write the page instead of printing')
    .option('--open', 'open the page (with --html)')
    .option('-o, --out <file>', 'where to write the page')
    .action(async (ref, flags) => {
      const src = need(sources, 'convo', 'conversation source');
      const r = await resolveSubject(sources, ref, flags);
      if (!r) return;
      const c = await src.load(r.subject, { system: Boolean(flags.system) || Boolean(flags.html) });
      if (flags.json) return json(c);
      if (flags.html) {
        writePage(sources, `convo-${c.subject.id.slice(0, 8)}.html`, renderConversationPage(c, { focusId: r.focusId }), flags);
        return;
      }
      out(renderConversation(c, { ...opts(flags), around: flags.around, radius: flags.radius, from: flags.from, to: flags.to, last: flags.last, lines: flags.lines, channels: list(flags.channel), system: flags.system, focusId: r.focusId }));
    });

  addCommon(convo.command('msg <id>').description('one message in full: headers, body, attachments, the run behind it')).action(async (id, flags) => {
    const src = need(sources, 'convo', 'conversation source');
    const d = await src.message(id);
    if (!d) throw new UsageError(`no message ${id}`);
    if (flags.json) return json(d);
    out(renderMessage(d, opts(flags)));
  });

  addCommon(convo.command('find <text>').description('search bodies across every conversation'))
    .option('--contact <ref>', 'only this subject')
    .option('--channel <kind>', 'one rail')
    .option('--since <t>', 'window: 48h, 3d, 2w')
    .option('-n, --limit <n>', 'rows', (v) => Number(v), 30)
    .action(async (text, flags) => {
      const src = need(sources, 'convo', 'conversation source');
      let subject: ConvoSubject | undefined;
      if (flags.contact) {
        const r = await resolveSubject(sources, flags.contact, flags);
        if (!r) return;
        subject = r.subject;
      }
      const hits = await src.find(text, { subject, channel: flags.channel, since: since(flags.since), limit: flags.limit });
      if (flags.json) return json(hits);
      out(renderSearch(hits, text, opts(flags)));
    });

  addCommon(convo.command('who <ref>').description('resolve a ref: who it is, their addresses, who else is in the conversation')).action(async (ref, flags) => {
    const src = need(sources, 'convo', 'conversation source');
    const r = await resolveSubject(sources, ref, flags);
    if (!r) return;
    const c = await src.load(r.subject);
    if (flags.json) return json({ subject: c.subject, participants: c.participants, total: c.total });
    out(renderWho(c, opts(flags)));
  });
}
