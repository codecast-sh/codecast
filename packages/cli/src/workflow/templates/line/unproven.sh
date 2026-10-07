# Unproven (the-line-end-to-end.md LE8): prove ended without writing its
# proof, so the miss was neither shown nor ruled out and the cause can be
# neither built nor dissolved. Park it where a person sees it: back to open,
# unless the hand already handed off blocked or needs_context (that left it in
# review), and a blocker carrying what Prove tried, or the run's last error
# when the hand left no output (it never spawned, or was killed).
case $handoff in
  blocked|needs_context) ;;
  *) cast task update $task_id -s open ;;
esac
note=$prove.output
[ -n "$note" ] || note=$last_error
cast task comment $task_id "Parked at prove: Prove wrote no proof, so the miss was neither shown nor ruled out. Rerun the line once it can be shown.${note:+ What Prove tried: $note}" -t blocker
