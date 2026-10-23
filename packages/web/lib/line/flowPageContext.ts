// Which flow's page the flows app is drawn on (/flows/<owner>), by its owner's
// handle; null on /flows. FlowPage provides it, FlowsView reads it.
import { createContext } from "react";

export const FlowPageContext = createContext<string | null>(null);
