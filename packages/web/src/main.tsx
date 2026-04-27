import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import { initAnalytics, setupErrorToasts } from "../lib/analytics";
import { App } from "./App";
import { idbReady } from "../store/inboxStore";
import "../app/globals.css";

initAnalytics();
setupErrorToasts();

await idbReady;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
