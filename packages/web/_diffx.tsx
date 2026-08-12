// Throwaway harness: mounts the real DiffView with a commentContext so the
// hover affordance can be screenshot-verified without an authed conversation.
// Delete before finishing.
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
    <div className="max-w-[680px] rounded-lg border border-sol-border overflow-hidden">
      <DiffView
        oldStr={OLD}
        newStr={NEW}
        maxLines={40}
        language="typescript"
        commentContext={{ conversationId: "conv1", anchorKey: "diff:x:y", filePath: "packages/web/components/DiffView.tsx" }}
      />
    </div>
  </div>,
);
