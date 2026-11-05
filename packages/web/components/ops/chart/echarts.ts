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
export type { EChartsOption, ECharts } from "echarts";
