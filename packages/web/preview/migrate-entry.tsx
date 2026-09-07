// Preview entry: the real Settings → Migration panel over a fixture world
// (preview/mocks), for eyeballing the layout without a backend. `?theme=light`
// flips the theme; default dark.
import "../app/globals.css";
import React from "react";
import { createRoot } from "react-dom/client";
import MigratePanel from "../app/settings/migrate/page";

const theme = new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.add(theme);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="min-h-screen bg-sol-bg text-sol-text">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-lg font-semibold text-sol-text">Migration</h1>
          <p className="text-xs text-sol-text-muted">Move many sessions to a cloud host or back, in one go</p>
        </div>
        <MigratePanel />
      </div>
    </div>
  </React.StrictMode>,
);
