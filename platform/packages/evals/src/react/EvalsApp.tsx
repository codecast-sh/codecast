// The whole area under one address: the shell, and the page for the view the
// address names, by the evalsPaths grammar under the host's base path. Each
// group registers its pages in its barrel; a host adds pages for views only
// it draws (codecast: the Multiplayer sim). A host's pages may be lazy: the
// shell stays up and says what is opening while one loads.

import { Suspense, useMemo, type ComponentType } from 'react';
import type { EvalsView, EvalsViewName } from '../client';
import { bisectPages } from './bisect';
import { freezePages } from './freeze';
import type { EvalsCapabilities } from '../contract';
import { useEvalsCapabilities, useEvalsHost, useEvalsPaths } from './hooks';
import type { EvalsPages } from './host';
import { runPages } from './run';
import { EvalsShell } from './shell/EvalsShell';
import { surfacePages } from './surface';

/** What a view's page is called while its code loads: under load a hop can take seconds, and a blank pane reads as broken. */
const OPENING: { [V in Exclude<EvalsViewName, 'not-found'>]: string } = {
  home: 'the wall',
  surface: 'the surface',
  freeze: 'the freeze',
  run: 'the run',
  compare: 'the comparison',
  'bisect-list': 'the bisects',
  'bisect-new': 'the attribution',
  bisect: 'the bisect',
  sim: 'the Multiplayer sim',
  'sim-run': 'the Multiplayer sim run',
  commit: 'the commit',
  patch: 'the patch',
};

function Opening({ view }: { view: EvalsView }) {
  return (
    <div className="ev-page ev-note" data-evals-loading="page">
      Opening {view.view === 'not-found' ? 'the page' : OPENING[view.view]}...
    </div>
  );
}

/** The capability a view's page reads: where the product's /health turns it off, the page is not shown rather than shown empty. */
const NEEDS: Partial<Record<EvalsViewName, keyof EvalsCapabilities>> = {
  freeze: 'freezes',
  compare: 'compare',
  'bisect-list': 'bisect',
  bisect: 'bisect',
  'bisect-new': 'attribution',
  commit: 'commits',
  patch: 'commits',
};

function ViewPage({ view, pages }: { view: EvalsView; pages: EvalsPages }) {
  const { ui: { EmptyState }, words } = useEvalsHost();
  const capabilities = useEvalsCapabilities();
  const paths = useEvalsPaths();
  const home = { label: 'Open the wall', href: paths.href.home() };
  if (view.view === 'not-found') {
    return <EmptyState title="No Evals page here" description={`${view.path} names no view. The wall at ${paths.basePath} ${words.wallLinks}.`} action={home} />;
  }
  const Page = pages[view.view] as ComponentType<{ view: EvalsView }> | undefined;
  const need = NEEDS[view.view];
  if (!Page || (need && !capabilities[need])) return <EmptyState title="Not shown here" description={`This product has no page for ${OPENING[view.view]}.`} action={home} />;
  return <Page view={view} />;
}

/** The area at `path` (the host's pathname; the query comes from its search params). */
export function EvalsApp({ path, pages }: { path: string; pages?: EvalsPages }) {
  const paths = useEvalsPaths();
  const query = useEvalsHost().useSearchParams().toString();
  const view = useMemo(() => paths.parse(path, query), [paths, path, query]);
  const all = useMemo<EvalsPages>(() => ({ ...surfacePages, ...runPages, ...freezePages, ...bisectPages, ...pages }), [pages]);
  return (
    <EvalsShell view={view}>
      <Suspense fallback={<Opening view={view} />}>
        <ViewPage view={view} pages={all} />
      </Suspense>
    </EvalsShell>
  );
}
