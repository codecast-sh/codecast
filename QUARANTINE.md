# Quarantined tests

A flaky test is one that passes and fails on the same code. It costs every run that trips over it, and it teaches people to rerun red builds instead of reading them. This file lists the flaky tests that are currently skipped, so the skip is visible and has a deadline.

## The rule

A quarantined test is fixed or deleted within 14 days of the date it was quarantined. Fixed means the cause is found and the test passes reliably in the suite it belongs to, under `--isolate` where CI uses it. If the behavior it covered still matters and nobody can fix the test in time, delete it and file a task for the coverage gap. A test never stays skipped past its deadline, and the deadline does not move.

Before quarantining, check that the failure is a flake. A test that fails alone on a quiet machine is a real failure; a test that fails only in a full run usually leaks state between files, and the package `CLAUDE.md` files list the known causes.

## How to quarantine a test

1. Skip only the flaky test (`test.skip`), never its whole file, and put `// quarantined: see QUARANTINE.md` on the line above it.
2. Add a row below with:
   - **Test**: the repo-relative file path, then ` > ` and the test name (`packages/web/lib/x.test.ts > keeps the tail`). `scripts/ci/quarantine.guard.test.ts` matches rows to marked files by that path and fails CI on a row past its deadline.
   - **Date**: the day it was quarantined (YYYY-MM-DD). The deadline is 14 days later.
   - **Owner**: the person or session that will fix or delete it.
   - **Symptom**: what the failure looks like (the assertion or error text, how often, which suite or CI job).
   - **Link**: the failing CI run, task or session.
3. When the test is fixed or deleted, remove its row in the same change.

## List

| Test | Date | Owner | Symptom | Link |
|------|------|-------|---------|------|
