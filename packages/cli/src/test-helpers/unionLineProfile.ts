// Union's line profile as it is committed in its repo (line-profile.md LP2),
// shared by the line.cast template tests.
export const UNION_PROFILE = `
[line]
team = "Union"
project = "Agent Quality"
principles = ["outreach/docs/line/principles.md"]
prompting = "outreach/docs/line/prompting.md"
size_budget = 400
watch_days = 7

[line.commands]
check = "bun outreach/backend/scripts/line.ts check --base $default_branch"
prove = "bun outreach/backend/scripts/line.ts prove --task $task_id --dir $run_dir"
eval  = "bun outreach/backend/scripts/line.ts eval --base $default_branch --dir $run_dir --out $run_dir/reps.json"
ship  = "bun outreach/backend/scripts/line.ts ship --task $task_id --branch $branch --run $run_id --dir $run_dir --into $default_branch"
`;
