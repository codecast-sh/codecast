/**
 * The Bisect group: attribution, a commit or a kept patch, and the bisect
 * pages. `bisectPages` names the pages EvalsApp routes to. The writes (plan,
 * start, stop) and kept patches are the host's slots; without them the pages
 * only read.
 */
import type { EvalsPages } from '../host';
import { BisectListPage } from './pages/BisectListPage';
import { BisectNewPage } from './pages/BisectNewPage';
import { BisectPage } from './pages/BisectPage';
import { CommitPage, PatchPage } from './pages/CodePage';

export { AttributionAnswerCard, AttributionChecklist, AttributionEvidence, AttributionView, CandidateList, EndpointsBar, type AllCommitsToggle, type EndpointsValue } from './AttributionView';
export { BisectListView } from './BisectListView';
export { BisectPlanPanel, START_KEY, type BisectPlanPanelProps, type PlanSettings } from './BisectPlanPanel';
export { BisectRuler } from './BisectRuler';
export { BisectResult, BisectView, type BisectViewProps } from './BisectView';
export { CommitMarks, CommitPanel, CommitPanelView, PatchPanel, PatchPanelView, useCommitSession } from './CommitPanel';
export { BisectListPage, BisectNewPage, BisectPage, CommitPage, PatchPage };

export const bisectPages: EvalsPages = {
  commit: CommitPage,
  patch: PatchPage,
  'bisect-list': BisectListPage,
  'bisect-new': BisectNewPage,
  bisect: BisectPage,
};
