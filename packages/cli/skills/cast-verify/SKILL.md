---
name: cast-verify
description: Prove the work before calling it done, and leave the evidence where reviewers read it. Runs the repository's checks, exercises the change in the human's own browser or on the command line, captures screenshots or output, attaches them to the task and the thread, and only then marks the work done. Use before declaring done, before shipping, or when asked to verify.
argument-hint: "[url or command to exercise]"
---

Asserting success is worth nothing; evidence is what a reviewer can check
without rerunning. The rule is: show it, then say it.

## Checks

Run what the repository defines: typecheck, tests for the packages touched,
lint. Fix what fails. Keep the exact command and the last lines of its
output; they go in the evidence.

## Exercise the change

Pick the surface that matches the change:

- Web: `cast browser open <url>` in the human's Chrome, drive the flow with
  `cast browser do`, and capture `cast browser shot --share --alt "<what it
  shows>"` at the moments that prove the behaviour. A flow that a reader
  should watch: `cast browser` steps with shots before and after.
- CLI or API: run the real command against real data and keep the output.
- Backend: an end to end test or a request against the deployed function.
- Mobile: the simulator, with a screenshot via `cast image`.

Test the failure path too when the change has one. A screenshot of the happy
path alone proves half the claim.

## Attach

```bash
cast task comment <id> -t review - <<'EVIDENCE'
Verified: <one line per claim, each with the command or the image link>
Not verified: <what remains and why>
EVIDENCE
```

Put the same images inline in the reply as `![caption](url)` so the thread
shows them. When the change is on a pull request, the same block goes in the
PR description.

## Then

Mark the task done only for the claims that have evidence: `cast task done
<id> -m "<what was verified and how>"`. Anything without evidence stays open
and is named in the reply as not verified.
