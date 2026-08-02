// Throwaway verification harness for the integrated terminal v2. DELETE BEFORE
// COMMIT. Mounts the real TerminalPanel (bottom) + ConversationTerminalSplit
// (middle) inside the same flex-column shape DashboardLayout uses.
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import "./app/globals.css";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { ConversationTerminalSplit, toggleConversationTerminal, isConversationTerminalOpen } from "./components/terminal/ConversationTerminal";

const client = new ConvexReactClient("https://convex.codecast.sh");

(window as any).__harness = { toggleConversationTerminal, isConversationTerminalOpen };

createRoot(document.getElementById("root")!).render(
  <ConvexProvider client={client}>
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--sol-bg)" }}>
      <div data-fake-content style={{ flex: "1 1 0%", minHeight: 0 }} />
      <ConversationTerminalSplit convKey="harness-conv" />
      <TerminalPanel />
    </div>
  </ConvexProvider>,
);
