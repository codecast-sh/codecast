// What an opted-in workspace is told about the learning loop
// (docs/architecture/org-hire.md H12). A leaf, so the CLI's template commands
// can print the switch without loading all of orgTemplateLearning.ts.

/** The switch's label and its one sentence: what leaves the workspace and what comes back. */
export const LEARNING_OPT_IN_LABEL = "Let Codecast learn from this workspace's template roles";
export const LEARNING_OPT_IN_SENTENCE = "Codecast reads how these roles were corrected and where they stalled, on its own servers, and keeps only generalized lessons about the template: never transcripts, quotes, names, customer data or code. In return, the templates you use improve.";
