// Codecast's Evals area lives at /evals: the platform's address grammar
// (@platform/evals/client evalsPaths) bound to that base. Every codecast
// reader of an Evals address (the views, the page, the tab list, the Line
// page) goes through this one binding, so the base is named once.

import { evalsPaths } from "@platform/evals/client";

export const codecastEvalsPaths = evalsPaths("/evals");

/** Every link into the area. */
export const evalsHref = codecastEvalsPaths.href;
