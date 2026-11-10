// Claude Code UserPromptSubmit -> periodic task/plan reminder. Not a script of
// its own: the job runs inside codecast-prompt.sh (userPromptHook.ts).

/** Assumes SESSION_ID, CC_DIR and feature_on (HOOK_STATE_DIR and
 *  HOOK_FEATURE_ON in hookJson.ts). Returns instead of exiting, and keeps
 *  every name it sets to itself: the jobs after it read the envelope's HOOK_*
 *  and their own COUNT. */
export const TASK_PULSE_JOB = `
task_pulse_job() {
local pulse_file counter_file count pulse task_id plan_id key val what
# Part of Tasks & Plans in Agent Features: off there, silent here.
feature_on work_enabled || return 0
pulse_file="$CC_DIR/task-pulse/$SESSION_ID.json"
[ -f "$pulse_file" ] || return 0

mkdir -p "$CC_DIR/task-pulse/counters"
counter_file="$CC_DIR/task-pulse/counters/$SESSION_ID"
count=0
[ -f "$counter_file" ] && IFS= read -r count <"$counter_file" 2>/dev/null
case "\${count:-}" in ''|*[!0-9]*) count=0 ;; esac
count=$((count + 1))
echo "$count" > "$counter_file"

# Emit every 8 turns
[ $((count % 8)) -ne 0 ] && return 0

# The pulse is one small JSON object the CLI writes (taskPulse.ts) and its ids
# are short plain ids, so cutting at the key reads them with builtins: no
# second JSON parser in the script and no process.
pulse=
IFS= read -r -d '' pulse <"$pulse_file" 2>/dev/null || true
task_id=
plan_id=
for key in task plan; do
  val=
  case "$pulse" in
    *"\\"$key\\""*)
      # Past the key, optional space, the colon, optional space, to a quoted
      # string. Anything else there (null, a number) reads as no id.
      val=\${pulse#*"\\"$key\\""}
      val=\${val#"\${val%%[![:space:]]*}"}
      case "$val" in :*) val=\${val#:}; val=\${val#"\${val%%[![:space:]]*}"} ;; *) val= ;; esac
      case "$val" in '"'*) val=\${val#'"'}; val=\${val%%'"'*} ;; *) val= ;; esac
      ;;
  esac
  if [ "$key" = task ]; then task_id=$val; else plan_id=$val; fi
done
what=""
[ -n "$task_id" ] && what="task $task_id"
if [ -n "$plan_id" ]; then
  if [ -n "$what" ]; then
    what="$what, plan $plan_id"
  else
    what="plan $plan_id"
  fi
fi
[ -z "$what" ] && return 0

echo "<task-reminder>You are working on $what. Check progress against acceptance criteria.</task-reminder>"
}
`;
