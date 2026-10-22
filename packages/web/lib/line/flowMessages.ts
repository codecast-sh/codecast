// What a person's press asks a session to do with flows (docs/architecture/flows.md FL4, FL5): the words the
// session receives, kept beside the other flow libs so the components that send them stay components.

/** What the session is asked: run its change through the flow, named after what the change does, and say how it ended. */
export function runThroughMessage(flow: { slug: string; label: string }): string {
  return `Run your change through the ${flow.label} flow: \`cast flow run ${flow.slug} --title "<what your change does>"\`. It takes every file this session changed here, so when you changed files that are not part of this change, name the ones that are with --only (check with --dry-run). When it ends, tell me where it stopped or that it passed.`;
}

/** What the session that ran a workflow is asked: make its shape a flow of the pool, its prompts free of this one task. */
export function addToFlowsMessage(name: string, runId: string): string {
  return `Add the ${name} workflow you ran (${runId}) to the pool of flows: \`cast flow import ${runId}\`. It starts as your draft. Make it general (its name, step names, description and prompts say what it does for any change, not this one task), then \`cast flow publish\` it. Tell me what the flow does and when to use it.`;
}
