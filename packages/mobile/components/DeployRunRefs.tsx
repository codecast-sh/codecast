// A GitHub Actions run in a message is the deploy it carried, when codecast
// knows one, and stays what was written otherwise (web: remarkEntityIds and
// EntityAwareLink). Most runs are CI, so the fallback is the common case.
import React from 'react';
import { actionsRunKey } from '@codecast/shared/contracts/deploys';
import { deployRunRefRegex, splitDeployRunRef } from '@codecast/shared/entities';
import { EntityPill } from './EntityPill';

/** A run's url: its deploy's pill, else `link` as it was. */
export function runOrLink(url: string, link: React.ReactElement, key?: string): React.ReactElement {
  return actionsRunKey(url) ? <EntityPill key={key} type="deploy" id={url} fallback={link} /> : link;
}

/**
 * Prose naming a run by its bare id ("Deploy 44822506482"): the words go to `words`, and each id becomes its deploy's
 * pill, falling back to the id as written (`asWritten` draws it).
 */
export function pushRunRefs(
  s: string,
  out: React.ReactNode[],
  words: (s: string) => void,
  asWritten: (s: string, key: string) => React.ReactNode,
  kp: string,
): void {
  const run = deployRunRefRegex();
  let at = 0;
  let r: RegExpExecArray | null;
  while ((r = run.exec(s)) !== null) {
    const { text: lead } = splitDeployRunRef(r[1], r[2]);
    words(s.slice(at, r.index) + lead);
    const key = `${kp}run${r.index}`;
    out.push(<EntityPill key={key} type="deploy" id={r[2]} fallback={asWritten(r[0].slice(lead.length), `${key}-`)} />);
    at = r.index + r[0].length;
  }
  if (at < s.length) words(s.slice(at));
}
