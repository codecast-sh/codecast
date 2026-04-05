// --- Model Stylesheet Types & Resolution ---

export interface ResolvedModel {
  provider: "anthropic" | "openai" | "gemini" | "unknown";
  model: string;
  raw: string;
  reasoning_effort?: "low" | "medium" | "high";
  temperature?: number;
  backend?: string;
}

export function parseModelSpec(raw: string): ResolvedModel {
  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    const model = rest.join("/");
    const knownProviders: Record<string, ResolvedModel["provider"]> = {
      anthropic: "anthropic", openai: "openai", gemini: "gemini", google: "gemini",
    };
    return { provider: knownProviders[provider] || "unknown", model, raw };
  }

  if (raw.startsWith("gpt-") || raw.startsWith("o1") || raw.startsWith("o3") || raw.startsWith("o4")) {
    return { provider: "openai", model: raw, raw };
  }
  if (raw.startsWith("gemini")) {
    return { provider: "gemini", model: raw, raw };
  }
  return { provider: "anthropic", model: raw, raw };
}

interface StylesheetRule {
  selector: string;
  properties: {
    model?: string;
    reasoning_effort?: "low" | "medium" | "high";
    temperature?: number;
    provider?: string;
    backend?: string;
  };
}

function parseModelStylesheet(stylesheet: string): StylesheetRule[] {
  const rules: StylesheetRule[] = [];
  const lines = stylesheet.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("//"));

  for (const line of lines) {
    const selectorMatch = line.match(/^([*#.]\S*)\s*\{(.+)\}/);
    if (!selectorMatch) continue;

    const selector = selectorMatch[1];
    const body = selectorMatch[2];
    const properties: StylesheetRule["properties"] = {};

    const modelMatch = body.match(/model:\s*([^;}\s]+)/);
    if (modelMatch) properties.model = modelMatch[1];

    const effortMatch = body.match(/reasoning_effort:\s*(low|medium|high)/);
    if (effortMatch) properties.reasoning_effort = effortMatch[1] as "low" | "medium" | "high";

    const tempMatch = body.match(/temperature:\s*([\d.]+)/);
    if (tempMatch) properties.temperature = parseFloat(tempMatch[1]);

    const providerMatch = body.match(/provider:\s*([^;}\s]+)/);
    if (providerMatch) properties.provider = providerMatch[1];

    const backendMatch = body.match(/backend:\s*([^;}\s]+)/);
    if (backendMatch) properties.backend = backendMatch[1];

    rules.push({ selector, properties });
  }
  return rules;
}

export function resolveTaskModel(plan: any, task: any, defaultModel = "opus"): string {
  const resolved = resolveTaskModelFull(plan, task, defaultModel);
  return resolved.model;
}

export function resolveTaskModelFull(plan: any, task: any, defaultModel = "opus"): ResolvedModel {
  if (task.model) return { ...parseModelSpec(task.model), raw: task.model };
  if (!plan.model_stylesheet) return parseModelSpec(defaultModel);

  const rules = parseModelStylesheet(plan.model_stylesheet);
  let bestMatch: ResolvedModel = parseModelSpec(defaultModel);
  let bestSpecificity = -1;

  for (const rule of rules) {
    let specificity = 0;
    let matches = false;

    if (rule.selector === "*") {
      matches = true;
      specificity = 0;
    } else if (rule.selector.startsWith("#")) {
      if (task.short_id === rule.selector.slice(1)) {
        matches = true;
        specificity = 3;
      }
    } else if (rule.selector.startsWith(".")) {
      const tag = rule.selector.slice(1);
      if (task.labels?.includes(tag) || task.tags?.includes(tag)) {
        matches = true;
        specificity = 2;
      }
    } else {
      if (task.task_type === rule.selector) {
        matches = true;
        specificity = 1;
      }
    }

    if (matches && specificity > bestSpecificity) {
      bestSpecificity = specificity;
      const model = rule.properties.model || defaultModel;
      bestMatch = {
        ...parseModelSpec(model),
        reasoning_effort: rule.properties.reasoning_effort,
        temperature: rule.properties.temperature,
        backend: rule.properties.backend,
      };
      if (rule.properties.provider) {
        bestMatch.provider = rule.properties.provider as ResolvedModel["provider"];
      }
    }
  }

  return bestMatch;
}

// --- Fidelity Control ---

export type FidelityLevel = "full" | "compact" | "summary_high" | "summary_medium" | "summary_low" | "truncate";

const FIDELITY_RANK: Record<FidelityLevel, number> = {
  full: 5, compact: 4, summary_high: 3, summary_medium: 2, summary_low: 1, truncate: 0,
};

export function resolveFidelity(plan: any, task: any): FidelityLevel {
  if (task.fidelity) return task.fidelity as FidelityLevel;
  if (plan.fidelity) return plan.fidelity as FidelityLevel;

  const doneTasks = (plan.tasks || []).filter((t: any) => t.status === "done");
  if (doneTasks.length > 50) return "summary_low";
  if (doneTasks.length > 30) return "summary_medium";
  if (doneTasks.length > 15) return "compact";
  return "full";
}

function buildDoneContext(doneTasks: any[], fidelity?: FidelityLevel): string {
  if (doneTasks.length === 0) return "";

  const level = fidelity || (doneTasks.length > 50 ? "summary_low" :
    doneTasks.length > 30 ? "summary_medium" :
    doneTasks.length > 15 ? "compact" : "full");

  switch (level) {
    case "truncate":
      return `\nAlready completed: ${doneTasks.length} tasks.`;

    case "summary_low":
      return `\nAlready completed: ${doneTasks.length} tasks covering: ${summarizeTaskTopics(doneTasks)}.`;

    case "summary_medium": {
      const recent = doneTasks.slice(-3);
      return `\nAlready completed (${doneTasks.length} total, topics: ${summarizeTaskTopics(doneTasks)}):\nRecent:\n${recent.map((t: any) => `- ${t.title}`).join("\n")}`;
    }

    case "summary_high": {
      const recent = doneTasks.slice(-8);
      const earlier = doneTasks.slice(0, -8);
      const summary = earlier.length > 0
        ? `${earlier.length} earlier tasks (${summarizeTaskTopics(earlier)})`
        : "";
      return `\nAlready completed (${doneTasks.length} total):\n${summary ? `- ${summary}\n` : ""}${recent.map((t: any) => `- ${t.title}`).join("\n")}`;
    }

    case "compact": {
      const recent = doneTasks.slice(-8);
      const earlier = doneTasks.slice(0, -8);
      const summary = earlier.length > 0
        ? `${earlier.length} earlier tasks completed (covering: ${summarizeTaskTopics(earlier)})`
        : "";
      return `\nAlready completed (${doneTasks.length} total):\n${summary ? `- ${summary}\n` : ""}${recent.map((t: any) => `- ${t.title}`).join("\n")}`;
    }

    case "full":
    default:
      return `\nAlready completed:\n${doneTasks.map((t: any) => `- ${t.title}`).join("\n")}`;
  }
}

function summarizeTaskTopics(tasks: any[]): string {
  const labels = new Set<string>();
  for (const t of tasks) {
    if (t.labels) t.labels.forEach((l: string) => labels.add(l));
    const words = t.title.split(/\s+/).slice(0, 3).join(" ");
    if (words) labels.add(words);
    if (labels.size >= 6) break;
  }
  return [...labels].slice(0, 5).join(", ");
}

// --- Typed Retrospective Categories ---

export const LEARNING_CATEGORIES = [
  "architecture", "tooling", "process", "testing", "performance", "security", "ux", "documentation",
] as const;
export type LearningCategory = typeof LEARNING_CATEGORIES[number];

export const FRICTION_KINDS = [
  "retry", "timeout", "wrong_approach", "unclear_spec", "merge_conflict",
  "dependency_issue", "environment", "flaky_test", "context_overflow",
] as const;
export type FrictionKind = typeof FRICTION_KINDS[number];

export const OPEN_ITEM_KINDS = [
  "tech_debt", "follow_up", "investigation", "optimization", "refactor", "test_coverage",
] as const;
export type OpenItemKind = typeof OPEN_ITEM_KINDS[number];

export interface TypedRetro {
  smoothness: "effortless" | "smooth" | "bumpy" | "struggled" | "failed";
  headline: string;
  learnings: Array<{ text: string; category: LearningCategory }>;
  friction_points: Array<{ text: string; kind: FrictionKind; severity: "low" | "medium" | "high" }>;
  open_items: Array<{ text: string; kind: OpenItemKind; priority: "low" | "medium" | "high" }>;
  generated_at: number;
}

export function buildRetroPrompt(plan: any, tasks: any[], progressLog?: any[]): string {
  const done = tasks.filter((t: any) => t.status === "done");
  const failed = tasks.filter((t: any) => t.status === "dropped");
  const blocked = tasks.filter((t: any) => t.execution_status === "blocked" || t.execution_status === "needs_context");
  const withConcerns = tasks.filter((t: any) => t.execution_status === "done_with_concerns");
  const totalRetries = tasks.reduce((sum: number, t: any) => sum + (t.retry_count || 0), 0);
  const totalTime = tasks.reduce((sum: number, t: any) => sum + (t.actual_minutes || 0), 0);

  const taskSummaries = tasks.map((t: any) => {
    const parts = [`- [${t.status}] ${t.title} (${t.short_id})`];
    if (t.execution_concerns) parts.push(`  concern: ${t.execution_concerns}`);
    if (t.retry_count) parts.push(`  retries: ${t.retry_count}`);
    return parts.join("\n");
  }).join("\n");

  const driveRounds = plan.drive_state?.rounds?.map((r: any) =>
    `Round ${r.round}: ${r.findings.length} findings, ${r.fixed.length} fixed${r.deferred?.length ? `, ${r.deferred.length} deferred` : ""}`
  ).join("\n") || "No drive rounds";

  const logEntries = (progressLog || plan.entries || plan.progress_log || []).slice(-10)
    .map((e: any) => `- ${e.content || e.entry}`).join("\n");

  return `Generate a structured retrospective for this plan. Return ONLY valid JSON.

Plan: ${plan.title} (${plan.short_id})
Goal: ${plan.goal || "N/A"}
Status: ${plan.status}
Stats: ${done.length} done, ${failed.length} dropped, ${blocked.length} blocked, ${withConcerns.length} with concerns
Total retries: ${totalRetries}
Time: ${totalTime ? `${totalTime}m` : "not tracked"}

Tasks:
${taskSummaries}

Drive rounds:
${driveRounds}

Activity log (last 10):
${logEntries}

Return JSON with this exact shape:
{
  "smoothness": "effortless|smooth|bumpy|struggled|failed",
  "headline": "One sentence summary of the plan execution",
  "learnings": [{"text": "What worked well", "category": "${LEARNING_CATEGORIES.join("|")}"}],
  "friction_points": [{"text": "What caused delays", "kind": "${FRICTION_KINDS.join("|")}", "severity": "low|medium|high"}],
  "open_items": [{"text": "Tech debt or follow-ups", "kind": "${OPEN_ITEM_KINDS.join("|")}", "priority": "low|medium|high"}]
}

Categories for learnings: ${LEARNING_CATEGORIES.join(", ")}
Kinds for friction: ${FRICTION_KINDS.join(", ")}
Kinds for open items: ${OPEN_ITEM_KINDS.join(", ")}`;
}

// --- Prompt Builders ---

export function buildImplementerPrompt(plan: any, task: any): string {
  const acceptance = task.acceptance_criteria?.length
    ? task.acceptance_criteria.map((ac: string) => `- ${ac}`).join("\n")
    : "None specified";

  const steps = task.steps?.length
    ? task.steps.map((s: any, i: number) => `${i + 1}. ${s.done ? "[x]" : "[ ]"} ${s.title}${s.verification ? ` (verify: ${s.verification})` : ""}`).join("\n")
    : "";

  const doneTasks = (plan.tasks || []).filter((t: any) => t.status === "done");
  const fidelity = resolveFidelity(plan, task);
  const doneContext = buildDoneContext(doneTasks, fidelity);

  const threadContext = task.thread_id
    ? `\nThread: ${task.thread_id} (share context only with tasks in the same thread)`
    : "";

  const planContext = [
    `Plan: ${plan.title} (${plan.short_id})`,
    plan.goal ? `Goal: ${plan.goal}` : "",
    `Task: ${task.title} (${task.short_id})`,
    task.description ? `\n${task.description}` : "",
    doneContext,
    threadContext,
  ].filter(Boolean).join("\n");

  return `You are implementing a task. Your progress is visible to the team in the codecast dashboard.

Start by binding to this task: \`cast task start ${task.short_id}\`

## Context
${planContext}

## Acceptance Criteria
${acceptance}
${steps ? `\n## Steps\n${steps}\n` : ""}
## How to work

1. Read the acceptance criteria and relevant code. If anything is unclear, output NEEDS_CONTEXT: <what you need>.
2. Implement in small commits. Conventional commits format with trailers:
   \`git commit -m "feat(scope): description\n\nCodecast-Plan: ${plan.short_id}\nCodecast-Task: ${task.short_id}"\`
3. Before reporting done, verify: typecheck (\`npx tsc --noEmit\`), run related tests, review your diff for dead code and slop.
4. If the change is user-facing, take a screenshot as evidence.

## When done

\`cast task done ${task.short_id} -m "what you implemented and how you verified it"\`

## If problems

Use these markers (exact format, the orchestrator parses them):
- **BLOCKED: <reason>** — hard blocker, can't proceed
- **NEEDS_CONTEXT: <what>** — need information or clarification
- **DONE_WITH_CONCERNS: <concern>** — completed but with worries`;
}

export function buildReviewerPrompt(plan: any, task: any, branchName: string): string {
  const planContext = [
    `Plan: ${plan.title} (${plan.short_id})`,
    plan.goal ? `Goal: ${plan.goal}` : "",
  ].filter(Boolean).join("\n");

  const acceptance = task.acceptance_criteria?.length
    ? task.acceptance_criteria.map((ac: string) => `- ${ac}`).join("\n")
    : "None specified";

  return `You are a code reviewer agent. Your job is to review a completed task's changes and provide a pass/fail verdict.

## Context
${planContext}
Task: ${task.title} (${task.short_id})
Branch: ${branchName}

## Acceptance Criteria
${acceptance}

## Workflow

1) Get context
- Run \`codecast task context ${task.short_id}\` to understand what was expected
- Run \`git diff main...${branchName}\` to see all changes
- Read the files that were modified

2) Review criteria
Check each of these:
- **Correctness**: Does the code actually implement what the task specifies?
- **Acceptance criteria**: Are all acceptance criteria met?
- **Code quality**: No obvious bugs, no dead code, no unnecessary complexity
- **No regressions**: Changes don't break existing functionality
- **Tests**: If tests were expected, are they present and meaningful?
- **No AI slop**: No unnecessary comments, over-abstractions, or defensive code

3) Verdict
If the implementation is good:
\`\`\`
codecast task comment ${task.short_id} "## Review: PASS

Summary of what was reviewed and why it passes." -t note
\`\`\`

If issues found:
\`\`\`
codecast task comment ${task.short_id} "## Review: FAIL

Issues:
- Issue 1
- Issue 2

Suggested fixes:
- Fix 1
- Fix 2" -t blocker
\`\`\`

Mark the task with execution status:
- PASS: \`codecast task update ${task.short_id} --execution-status done\`
- Minor concerns: \`codecast task update ${task.short_id} --execution-status done_with_concerns\`
- FAIL: \`codecast task update ${task.short_id} --execution-status needs_context\``;
}

export function buildCriticPrompt(plan: any, scope: string, roundNumber: number): string {
  const planContext = [
    `Plan: ${plan.title} (${plan.short_id})`,
    plan.goal ? `Goal: ${plan.goal}` : "",
  ].filter(Boolean).join("\n");

  return `You are a critic agent for drive round ${roundNumber}. Your job is to find issues in the current state of the project.

## Context
${planContext}
Scope: ${scope}
Round: ${roundNumber}

## Workflow

1) Get context
- Run \`codecast plan show ${plan.short_id}\` to understand the plan
- Read the relevant code files in the scope area
- Check recent git history for context

2) Analysis
Look for:
- **Bugs**: Logic errors, edge cases, race conditions
- **UX issues**: Confusing UI, missing feedback, accessibility problems
- **Missing features**: Things specified in the plan that aren't implemented
- **Code quality**: Dead code, duplication, poor naming
- **Performance**: Obvious N+1 queries, missing indexes, unnecessary re-renders
- **Security**: Input validation gaps, auth issues

3) Report findings
Output a structured list of findings, each with:
- Severity: critical / major / minor
- Location: file:line
- Description: What's wrong
- Suggested fix: How to fix it

Format your output as:

FINDINGS:
1. [critical] file.ts:42 - Description. Fix: suggestion.
2. [major] component.tsx:15 - Description. Fix: suggestion.
...

SUMMARY:
- N critical, M major, P minor issues found
- Top priority: description of most important issue

The orchestrator will use these findings to create fix tasks or record them in the drive state.`;
}

// --- Task Prompt Templates ---
// Per-agent-type templates for spawning agents on tasks via `cast task start`.
// Uses {{variable}} syntax for mustache-style interpolation.

export interface TaskPromptInput {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  priority: string;
  status: string | null;
  labels: string[] | null;
}

const TASK_PROMPT_VARIABLES: Record<string, (t: TaskPromptInput) => string> = {
  id: (t) => t.id,
  slug: (t) => t.slug,
  title: (t) => t.title,
  description: (t) => t.description || "No description provided.",
  priority: (t) => t.priority || "none",
  status: (t) => t.status || "Unknown",
  labels: (t) => t.labels?.join(", ") || "None",
};

export const DEFAULT_TASK_PROMPT_TEMPLATE = `Task: "{{title}}" ({{slug}})
Priority: {{priority}}
Status: {{status}}
Labels: {{labels}}

{{description}}

Work in the current workspace. Inspect the relevant code, make the needed changes, verify them when practical, and update the task with a short summary when done:
\`cast task done {{id}} -m "summary of what you did"\``;

export function renderTaskPromptTemplate(template: string, task: TaskPromptInput): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => {
    const fn = TASK_PROMPT_VARIABLES[key.trim()];
    return fn ? fn(task) : `{{${key}}}`;
  }).trim();
}

export function buildTaskPrompt(task: TaskPromptInput, template?: string): string {
  return renderTaskPromptTemplate(template || DEFAULT_TASK_PROMPT_TEMPLATE, task);
}
