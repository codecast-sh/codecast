export interface ResolvedModel {
  provider: "anthropic" | "openai" | "gemini" | "unknown";
  model: string;
  raw: string;
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

export function resolveTaskModel(plan: any, task: any, defaultModel = "opus"): string {
  if (task.model) return task.model;
  if (!plan.model_stylesheet) return defaultModel;

  const rules = parseModelStylesheet(plan.model_stylesheet);
  let bestMatch = defaultModel;
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
      bestMatch = rule.model;
    }
  }

  return bestMatch;
}

interface StylesheetRule {
  selector: string;
  model: string;
}

function parseModelStylesheet(stylesheet: string): StylesheetRule[] {
  const rules: StylesheetRule[] = [];
  const lines = stylesheet.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("//"));

  for (const line of lines) {
    const match = line.match(/^([*#.]\S*)\s*\{\s*model:\s*([^;}\s]+)/);
    if (match) {
      rules.push({ selector: match[1], model: match[2] });
    }
  }
  return rules;
}

function buildDoneContext(doneTasks: any[], waveNumber?: number): string {
  if (doneTasks.length === 0) return "";

  const maxFull = 15;
  if (doneTasks.length <= maxFull) {
    return `\nAlready completed:\n${doneTasks.map((t: any) => `- ${t.title}`).join("\n")}`;
  }

  const recent = doneTasks.slice(-8);
  const earlier = doneTasks.slice(0, -8);
  const summary = `${earlier.length} earlier tasks completed (covering: ${summarizeTaskTopics(earlier)})`;
  return `\nAlready completed (${doneTasks.length} total):\n- ${summary}\n${recent.map((t: any) => `- ${t.title}`).join("\n")}`;
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

export function buildImplementerPrompt(plan: any, task: any): string {
  const acceptance = task.acceptance_criteria?.length
    ? task.acceptance_criteria.map((ac: string) => `- ${ac}`).join("\n")
    : "None specified";

  const steps = task.steps?.length
    ? task.steps.map((s: any, i: number) => `${i + 1}. ${s.done ? "[x]" : "[ ]"} ${s.title}${s.verification ? ` (verify: ${s.verification})` : ""}`).join("\n")
    : "";

  const doneTasks = (plan.tasks || []).filter((t: any) => t.status === "done");
  const doneContext = buildDoneContext(doneTasks, task.wave_number);

  const planContext = [
    `Plan: ${plan.title} (${plan.short_id})`,
    plan.goal ? `Goal: ${plan.goal}` : "",
    `Task: ${task.title} (${task.short_id})`,
    task.description ? `\n${task.description}` : "",
    doneContext,
  ].filter(Boolean).join("\n");

  return `You are implementing a specific task from a plan. Follow structured development methodology.

## First step

Bind yourself to this task so your session is tracked:
\`\`\`bash
cast task start ${task.short_id}
\`\`\`

## Context
${planContext}

## Acceptance Criteria
${acceptance}
${steps ? `\n## Steps\n${steps}\n` : ""}
## Development Protocol

1. **Understand first**: Read acceptance criteria and relevant code. If unclear, report NEEDS_CONTEXT.
2. **Worktree**: If available, work in your worktree branch. Commit on the branch -- autopilot handles merging to main.
3. **Test-driven**: Write failing test -> implement minimal code -> verify -> commit.
4. **Small commits**: One logical change per commit. Conventional commits format. Add trailers to every commit:
   \`\`\`
   git commit -m "feat(scope): description

   Codecast-Plan: ${plan.short_id}
   Codecast-Task: ${task.short_id}"
   \`\`\`
5. **Verify everything**: Run tests, check build. Evidence before claims.
6. **Self-review**: Before reporting done, review your changes. Check for AI slop, missing edge cases, dead code.

## Verification Protocol

Before marking any task as done, you MUST complete this checklist:

1. **Typecheck**: Run \`npx tsc --noEmit\` in the relevant package directory. If it fails, fix the errors before proceeding.
2. **Tests**: Run tests related to your changed files. If a test suite exists (jest, vitest, etc.), run it. Include the test output in your completion message.
3. **Screenshot**: If the change is user-facing (UI, visual), take a screenshot as evidence using the browser or simulator tools.
4. **Build**: If you modified build-relevant files, verify the build still succeeds.
5. **Diff review**: Run \`git diff\` and review every changed line. Remove dead code, unnecessary comments, and AI slop.

Only proceed to reporting after ALL applicable checks pass. Include verification evidence in your completion message.

## Escalation Protocol

When you encounter problems, use these structured markers in your output so the orchestrator can detect and act on them:

- **BLOCKED: <reason>** -- You cannot complete the task due to a hard blocker (missing dependency, broken upstream, access issue). The orchestrator will pause the task and flag it for intervention.
- **NEEDS_CONTEXT: <what you need>** -- You need information that isn't available in the codebase or task description (clarification on spec, access to an API key, design decision). The orchestrator will escalate to the user.
- **DONE_WITH_CONCERNS: <concern>** -- You completed the task but have quality or correctness worries (untested edge case, potential regression, tech debt introduced). The orchestrator will mark it for review.

Always use the exact marker format above (uppercase, colon, space, description) so automated parsing can detect it.

## Reporting

When done:
\`\`\`bash
cast task done ${task.short_id} -m "what you implemented and how you verified it"
\`\`\``;
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
