// Throwaway verification harness for the `[Image N]` draft placeholders.
// Mounts the REAL MessageInput against the REAL stylesheet with no auth —
// unauthed Convex queries just stay undefined, which is enough because the
// placeholder is inserted at paste time, before any upload. Delete after use.
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { MessageInput } from "./components/ConversationView";
import { CONVEX_URL } from "./lib/convexUrl";
import "./app/globals.css";

const convex = new ConvexReactClient(CONVEX_URL);
// Hold every mutation open so a pasted image stays in the "uploading" state
// instead of failing fast on the missing auth — that's the state a real user
// sees while the upload is in flight, and the one the placeholder lives in.
(convex as any).mutation = () => new Promise(() => {});
const CONV = "_imgph_harness_conversation";

function Harness() {
  return (
    <ConvexProvider client={convex}>
      <div style={{ background: "var(--sol-bg)", padding: 24, borderRadius: 12 }}>
        <MessageInput conversationId={CONV} bareComposer autoFocusInput />
      </div>
    </ConvexProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

// Build a 1x1 PNG File and fire a real paste at the composer's textarea, the
// same shape the browser delivers on Cmd-V.
function pngFile(name: string): File {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ),
    (c) => c.charCodeAt(0)
  );
  return new File([bytes], name, { type: "image/png" });
}

(window as any).__pasteImage = (name = "shot.png") => {
  const el = document.querySelector("textarea");
  if (!el) return "no textarea";
  const dt = new DataTransfer();
  dt.items.add(pngFile(name));
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  return "pasted";
};

(window as any).__draft = () => document.querySelector("textarea")?.value ?? null;

(window as any).__chips = () =>
  document.querySelectorAll('[class*="group"] img[src^="blob:"]').length;
