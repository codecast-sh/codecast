/**
 * The Freeze group: one freeze across time and its rep strip, two runs side
 * by side, and the parts the surface page borrows: the assay plate
 * (FreezeLedger), the compare drawer (ComparePanel) and the epoch sheet
 * (EpochDiffSheet). `freezePages` names the pages EvalsApp routes to.
 */
import type { EvalsPages } from '../host';
import { ComparePage } from './pages/ComparePage';
import { FreezePage } from './pages/FreezePage';

export { FreezeView, FreezeRepStrip, LabelCard, ProductionCard, MomentPane, type FreezeViewProps, type FreezeRepStripProps, type CardPairing } from './FreezeView';
export { FreezeLedger, type FreezeLedgerProps } from './FreezeLedger';
export { CompareView } from './CompareView';
export { ComparePanel, type ComparePanelProps } from './ComparePanel';
export { EpochDiffSheet, type EpochDiffSheetProps } from './EpochDiffSheet';
export { FreezePage } from './pages/FreezePage';
export { ComparePage } from './pages/ComparePage';

export const freezePages: EvalsPages = { freeze: FreezePage, compare: ComparePage };
