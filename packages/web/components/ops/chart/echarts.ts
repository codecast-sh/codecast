// The one place Ops registers ECharts: only the charts, components and
// renderer Ops draws with, so the bundle carries those and nothing else.
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  BrushComponent, DataZoomComponent, GraphicComponent, GridComponent, LegendComponent,
  MarkAreaComponent, MarkLineComponent, ToolboxComponent, TooltipComponent, VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  LineChart, BarChart, ScatterChart, HeatmapChart,
  GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, MarkAreaComponent,
  BrushComponent, ToolboxComponent, GraphicComponent, LegendComponent, VisualMapComponent,
  CanvasRenderer,
]);

export { echarts };
/**
 * An option as Ops builds it. ECharts' own option type is a union of every
 * series and component shape; checking literals against it took the web
 * typecheck past its memory cap, so options are plain objects here and
 * ECharts reads them at run time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EChartsOption = Record<string, any>;
/** The instance type core's init returns; the full package declares its own copy of the class. */
export type ECharts = ReturnType<typeof echarts.init>;
