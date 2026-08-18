// Parsers for the Workflow tool: the script's meta literal and the plain-text
// launch receipt ("Workflow launched in background. Task ID: … Run ID: wf_…").
// Pure; shared by ConversationView's WorkflowToolBlock and its tests.

export function parseWorkflowScriptMeta(script: string): { name?: string; description?: string } {
  const head = script.slice(0, 2000);
  return {
    name: head.match(/\bname:\s*['"`]([^'"`\n]+)['"`]/)?.[1],
    description: head.match(/\bdescription:\s*['"`]([^'"`\n]+)['"`]/)?.[1],
  };
}

export function parseWorkflowLaunch(content: string): { taskId?: string; summary?: string; scriptFile?: string; runId?: string } {
  return {
    taskId: content.match(/\bTask ID:\s*(\S+)/)?.[1],
    summary: content.match(/\bSummary:\s*([^\n]+)/)?.[1],
    scriptFile: content.match(/\bScript file:\s*([^\n]+)/)?.[1],
    runId: content.match(/\bRun ID:\s*(wf_[\w-]+)/)?.[1],
  };
}
