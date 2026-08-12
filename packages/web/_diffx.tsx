// Throwaway harness: mounts the real DiffView inside a stand-in for the tool
// card that wraps it in ConversationView, so the gutter handle can be
// screenshot-verified without an authed conversation. Delete before finishing.
import { createRoot } from "react-dom/client";
import "./app/globals.css";
import { DiffView } from "./components/DiffView";

const OLD = `// Look up the row the pointer is on.
// prefix each hidden line
// and keep the anchor stable
// rows carry their own key
for (const row of rows) {
  if (!row.visible) continue;
  if (row.kind === "sep") continue;
  if (seen.has(row.key)) continue;
  rows.push(row);
}`;

const NEW = `// Look up the row the pointer is on.
// prefix each hidden line
for (const row of rows) {
  if (!row.visible) continue;
  rows.push(row);
}`;

createRoot(document.getElementById("root")!).render(
  <div className="bg-sol-bg text-sol-text p-8 min-h-screen">
    {/* Mirrors ConversationView's expanded tool-card wrapper + its left gutter. */}
    <div className="max-w-[760px] pl-10">
      <div className="text-xs font-mono text-sol-text-muted mb-1">
        <span className="text-sol-blue">Edit</span> packages/web/components/DiffView.tsx
      </div>
      <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset">
        <DiffView
          oldStr={OLD}
          newStr={NEW}
          maxLines={40}
          language="typescript"
          showLineNumbers
          commentContext={{
            conversationId: "conv1",
            anchorKey: "diff:x:y",
            filePath: "packages/web/components/DiffView.tsx",
          }}
        />
      </div>
    </div>
  </div>,
);
