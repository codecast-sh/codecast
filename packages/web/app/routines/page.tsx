"use client";
// /routines: the one Workflows entry (docs/architecture/the-line.md L10).
// The tab shell already routes /routines to the workflows page
// (components/RoutePane.tsx); this file gives a direct load the same page.
// /workflows keeps working as the older address of the same surface.
export { default } from "../workflows/page";
