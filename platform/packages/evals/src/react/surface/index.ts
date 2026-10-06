/**
 * The Surface group: the wall and a surface: the score strip, the seismograph,
 * batch verdicts and flips, and a product's own gate (P4c). `surfacePages`
 * names the pages EvalsApp routes to. The rep marks, epoch bands and footing
 * glyphs are exported for the freeze page's chart, which draws the same reps.
 */
import type { EvalsPages } from '../host';
import { HomePage } from './HomePage';
import { SurfacePage } from './SurfacePage';

export { HomePage } from './HomePage';
export { SurfacePage } from './SurfacePage';
export { SurfaceWallView, type SurfaceWallViewProps } from './SurfaceWallView';
export { SurfaceView, type Loaded, type SurfaceHeaderInfo, type SurfaceViewProps } from './SurfaceView';
export { WhatMoved } from './WhatMoved';
export { BatchTip, EpochBands, RepHatch, RepMark, RepTip, Seismograph, type RepTone, type SeismographProps } from './Seismograph';
export { FootingGlyph, ScoreStrip, type ScoreStripProps, type StripDot } from './ScoreStrip';
export { BrushRect } from './BrushRect';
export { useDayBrush, type BrushDrag } from './useDayBrush';
export { GateChip } from './GateChip';

export const surfacePages: EvalsPages = { home: HomePage, surface: SurfacePage };
