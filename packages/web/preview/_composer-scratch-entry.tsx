import "../app/globals.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { ComposerSendButton } from "../components/ComposerShell";

const theme = new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.add(theme);
const tip = (b: React.ReactElement, words: string) => <span title={words} className="inline-flex">{b}</span>;
const Row = ({ name, children }: { name: string; children: React.ReactNode }) => (
  <div className="flex items-center gap-6 py-3 border-b border-sol-border/40"><span className="w-64 text-xs text-sol-text-muted">{name}</span>{children}</div>
);
createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-sol-bg text-sol-text p-8">
    <form onSubmit={(e) => e.preventDefault()} className="max-w-2xl">
      <Row name="idle, text in the box"><ComposerSendButton canSubmit tip={tip} /></Row>
      <Row name="turn running, empty box"><ComposerSendButton canSubmit={false} stop={{ label: "Stop", onStop: () => {}, accel: "escape" }} tip={tip} /></Row>
      <Row name="turn running, text (before)"><ComposerSendButton canSubmit stopAndSend={{ onStopAndSend: () => {} }} tip={tip} /></Row>
      <Row name="turn running, text (now)"><ComposerSendButton canSubmit stopAndSend={{ onStopAndSend: () => {} }} queueSend={{ onQueue: () => {} }} tip={tip} /></Row>
    </form>
  </div>,
);
