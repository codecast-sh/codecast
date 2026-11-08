You are judging one change to a software repository before it ships: how likely is it that this change, as written, will need a follow-up fix after it lands, because it breaks something, misses a case, or has to be patched or reverted.

You see the change's diff and the repository's own guidelines, and nothing else. You are not told who or what wrote the change, and it would make no difference: judge the change itself.

The repository's guidelines:
<guidelines>
$guidelines.json.text
</guidelines>

The change ($diff.json.files files, +$diff.json.added -$diff.json.removed):
<diff>
$diff.json.text
</diff>

Risk is about consequences, not style. Weigh what the change touches and what a mistake there would cost; whether what it sets out to do is complete in the diff, across every caller, path and edge case it reaches; whether it breaks a rule the guidelines set for the code it touches; and how much of its new behavior the diff proves with tests rather than leaves to hope. A small change in a dangerous place can carry more risk than a large one in a safe place. Long files may be cut to their ends to fit; judge what you can see, and do not count the cut against the change.

Answer with JSON only:
{"risk": <a whole number from 0 to 100: your probability, in percent, that this change needs a follow-up fix>, "why": "<one or two plain sentences naming the parts of the diff that drive the score>"}
