# Dissolve (the-line-end-to-end.md LE8, the-line-model.md LM8): the miss did
# not reproduce, so the cause closes with its evidence. When prove found the
# findings were the judge's own mistake (the system behaved well and the judge
# scored it wrong), it left those moments in the run's files as
# judge-defects.json, a JSON list of {judge, finding, sentence, name}: the
# finding the judge got wrong and one sentence stating what a correct judgment
# does. The cause closes saying so, and the project's judge evals take the
# moments as freezes from there. Prints one JSON line first, ahead of what
# cast says, because the run's node keeps only the head of the output as its
# result: {"dissolved": "judge_defect", "moments": n} or {"dissolved": "no_repro"}.
file=$run_dir/judge-defects.json
if [ -s "$file" ]; then
  n=$(grep -o '"finding"' "$file" | wc -l | tr -d ' ')
  printf '{"dissolved": "judge_defect", "moments": %s}\n' "$n"
  cast task done $task_id -m "Dissolved: the findings were the judge's own mistake. $n moments are recorded for that judge's evals; the prove comment has the evidence."
else
  printf '{"dissolved": "no_repro"}\n'
  cast task done $task_id -m "Dissolved: the miss did not reproduce. The evidence is in the prove comment."
fi
