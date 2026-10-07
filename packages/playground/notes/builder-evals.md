# Builder evals

`scripts/builder-evals.ts` runs 8 scenarios of 4 real requests each (32 builds)
against the dev deployment: a new app, a concrete change, an open-ended one
("make it more fun", "make it feel calmer") and one pointed at an element with
the picker. Every version that goes live is fetched as served, mounted and
used in happy-dom (`scripts/lib/mount.ts`: click every button, type, submit,
drag across canvases, press keys) against a mock SDK that applies the
backend's own value checks, then graded by an Opus judge on whether it did
what was asked, whether it stays multiplayer, and how it looks.

A **hit** is: live, runs with no errors, no defect from the checks (starter
leftovers, kept the starter's palette, a write on every pointer move, data the
backend would refuse), and the judge gives did_it 2, multiplayer not 0, look 1+.

```
bun scripts/builder-evals.ts <label> [scenario...]   # run, writes /tmp/pg-evals/<label>/results.json
bun scripts/builder-evals.ts --stats <label>...      # summary and every miss
bun scripts/builder-evals.ts --rescore <label>       # mount again with the current checks
bun scripts/builder-evals.ts --rejudge <label>       # grade again with the current judge
```

The judge's look grade follows the product's taste: real software first, one
visual idea that fits the subject, playful in small doses. Toy styling or
decoration that crowds the use scores 1. The baseline was regraded with this
judge, so before and after compare like for like.

## Runs (2026-10-07, builder claude-sonnet-5-5)

| Run | What changed | Hits | Top look | Median all | Median new app (max) | Median change | Median cost | Total |
|---|---|---|---|---|---|---|---|---|
| baseline | chunky starter, prompt as found | 16/32 | 13 | 27.1s | 31.2s (78.6s) | 25.1s | $0.066 | $2.22 |
| v2 | calm starter; prompt says the starter is a placeholder; real-software-first design; open-ended asks get 1 or 2 real changes; SDK docs give the write rate | 9/32 | 9 | 23.9s | 36.1s (78.8s) | 21.1s | $0.063 | $2.10 |
| v3 | every app gets its own palette and type; `setValue(prev => next)` documented as conflict-safe; effects are garnish on a real change | 31/32 | 30 | 25.6s | 36.6s (80.2s) | 24.0s | $0.065 | $2.23 |
| v4 | speed named as part of quality in Working | 31/32 | 30 | 24.7s | 33.5s (75.0s) | 22.7s | $0.060 | $2.03 |
| v5 | same prompt as v4; eval picks the innermost element by text or label | 31/32 | 29 | 22.8s | 37.7s (88.6s) | 22.1s | $0.057 | $2.01 |

Every build in every run went live (160/160).

## Effort runs (2026-10-07, round 3: thinking shown as summaries, finish names a spotlight)

Sonnet 5.5 defaults to effort high. Builds now set `output_config.effort` and
`thinking.display: "summarized"` (convex/builder/model.ts), and `finish`
takes a spotlight selector and a "try it" line.

| Run | Effort | Hits | Top look | Median change | Median new app (max) | Median cost | Total |
|---|---|---|---|---|---|---|---|
| effort-high | high (old prompt) | 32/32 | 29 | 22.7s | 32.4s (73.0s) | $0.058 | $1.94 |
| effort-medium | medium for all | 30/32 | 25 | 11.4s | 16.9s (24.2s) | $0.034 | $1.10 |
| effort-split | high for a new app, medium for a change | 31/32 | 26 | 9.6s | 29.0s (68.6s) | $0.038 | $1.52 |

- Medium for a new app shipped an unplayable platformer (jump 84px, first
  platform at 90px), so a new app's first build stays at high
  (`BUILDER_EFFORT`). New apps: 8/8 top grades in effort-split.
- Changes at medium: did-it 23/24 in both medium runs (the miss is the poll's
  standing "make it more fun"), look 2 on 18 and 19 of 24 against 21 at high.
  Not separated at this size (Fisher p about 0.5), but it points one way, so
  watch it. In exchange a change goes live in under half the time, which is
  the wait the room watches.

What moved the numbers:

- **Starter leftovers** (baseline, 12 misses): the first build edited the
  starter instead of replacing it, so the guestbook kept its "Wave hello"
  button and four apps shipped its dead CSS. Fixed by telling the builder what
  the starter is for.
- **Every app looked like the starter** (v2, 23 defects): with a calm,
  decent-looking starter, 6 of 8 new apps kept its palette byte for byte. The
  baseline had the same failure with its chunky sticker look, which is why
  every app came out toy-like. Fixed in v3 by asking for a look of its own
  per app, chosen for its subject. v3 palettes: a dark violet emoji chat, a
  night-blue drawing wall, a pond-green platformer, a sage todo list.
- **Writes on every move** (baseline pixels, 4 misses): painting wrote one doc
  per cell, which hits the 240-writes-a-minute limit within seconds of real
  drawing. Fixed by stating the limit and "write once per gesture" in the SDK
  docs; no write storms since.
- The judge alone rated the baseline well (30/32 on did_it/multiplayer), so
  the gain is in defects the checks catch and in look (13 to 29-30 top
  grades), not in whether requests got done.
- The speed line in v4 did not separate on latency (change latency
  Mann-Whitney z = -0.64, 24 a side). Mean cost per build fell 9%. It stays
  because it states the product's intent, not because it is proven faster.
- Time is all model time: setup, validation and commit add about 200ms per
  build (`build ... live:` log lines).

The one standing miss is the poll's "make it more fun" (1/32 in every run):
the builder adds reactions, confetti and a leader banner, and the judge wants
a new reason to play together. Every other open-ended request lands.

Harness gaps: the element picker found nothing for 2 of 8 element requests in
v5 (pixels, emoji), which then went in without an element. The judge reads
code, not pixels, so look grades are a code-level reading of the design.

## Round 6: the look, the SDK, first screens (2026-10-07)

The founder rejected the default look as a toy: in effort-split, 3 of 4 new
apps were set in Trebuchet, the only web fonts were Fredoka, Nunito and
Baloo 2, and surfaces were outlined stickers with hard offset shadows. The
prompt now asks for a well-made Google Font chosen for the subject, a type
scale and spacing, and borders, shadows and strong fills only where they
carry structure or state. `lookDefects` in the eval flags a novelty or
web-safe face, no web font, 3+ hard offset shadows or 5+ thick outlines,
and the judge's look rubric says the same.

- r6 (5 new scenarios, 11 builds): 9/11 hits, 0 look defects, every app
  loads a web font, no emdash in app text or summaries. Misses: weather
  throws only on the eval's emoji city search (harness artifact).
- r6-first (the 8 standing scenarios, new apps only): 7/8 hits, 0 look
  defects, 7/8 top look. Faces: Bricolage Grotesque (4), Fraunces, Young
  Serif, Schibsted, Familjen, DM Sans, Hanken. The miss is the poll keeping
  the starter's palette, an old failure mode (1/8).
- Every new app opened with content for one person alone (seeded groceries,
  a pre-filled drum groove, starter cities, seeded cards, a landscape on the
  pixel canvas, a practice bot in emoji roulette). The drawing guessing game
  still opens on an empty canvas with "I'll draw" and an invite card.
- Builder names: "Doodle guess", "Drum machine" replaced the regex names.
- The guessing game reached for the new SDK unprompted: useMine for the
  drawer's word, where-scoped strokes, removeWhere at round end, app.link
  for its invite.

Watch: faces converge. "From the whole library rather than the usual safe
pairing" moved r6's Fraunces/Instrument Sans (3 of 5) to Bricolage in r6-first
(4 of 8). Not separated; the builder cannot see other apps, so variety needs
more samples to judge, or a seed of its own.

## v5, every build

| Scenario | Step | Request | Time | Cost | Judge (did/mp/look) | Result |
|---|---|---|---|---|---|---|
| drawing | 0 | A multiplayer drawing wall ... | 54.8s | $0.101 | 2/2/2 | hit |
| drawing | 1 | make it more fun | 30.7s | $0.080 | 2/2/2 | hit |
| drawing | 2 | make this bigger and put an eraser next to it (picked a button) | 23.1s | $0.062 | 2/2/2 | hit |
| drawing | 3 | let me undo my last stroke | 10.7s | $0.043 | 2/2/2 | hit |
| poll | 0 | A voting poll for where the team should go for lunch ... | 26.4s | $0.061 | 2/2/2 | hit |
| poll | 1 | show the results as bars that animate when votes come in | 24.3s | $0.053 | 2/2/2 | hit |
| poll | 2 | change this to ask about Friday's team dinner instead (picked h1) | 7.6s | $0.025 | 2/-/2 | hit |
| poll | 3 | make it more fun | 22.3s | $0.053 | 1/1/1 | miss |
| platformer | 0 | A tiny platformer: a frog hops ... shared high score board | 88.6s | $0.173 | 2/2/2 | hit |
| platformer | 1 | add a double jump | 20.1s | $0.057 | 2/-/2 | hit |
| platformer | 2 | make it more fun | 35.5s | $0.090 | 2/2/2 | hit |
| platformer | 3 | make this bigger and put a little trophy next to it (picked "High scores") | 6.3s | $0.041 | 2/-/2 | hit |
| todo | 0 | A shared todo list for our flat ... | 28.1s | $0.067 | 2/2/2 | hit |
| todo | 1 | let people drag chores to reorder them | 21.5s | $0.052 | 2/2/2 | hit |
| todo | 2 | let me pick a due day right here when I add a chore (picked input) | 15.7s | $0.046 | 2/-/2 | hit |
| todo | 3 | dark mode please | 20.4s | $0.057 | 2/-/2 | hit |
| guestbook | 0 | A guestbook for my birthday party ... sticker | 27.9s | $0.064 | 2/2/2 | hit |
| guestbook | 1 | make it look like a cork board with pinned paper notes | 26.5s | $0.063 | 2/-/2 | hit |
| guestbook | 2 | make it more fun | 22.4s | $0.057 | 2/2/1 | hit |
| guestbook | 3 | make this say 'Pin it' and give it a little wiggle (picked a button) | 13.2s | $0.041 | 2/-/1 | hit |
| pixels | 0 | A collaborative 32x32 pixel art canvas ... | 45.1s | $0.086 | 2/2/2 | hit |
| pixels | 1 | add a timelapse that replays how the picture was made | 22.2s | $0.058 | 2/2/2 | hit |
| pixels | 2 | add a few pastel colors here (pick found nothing) | 8.3s | $0.026 | 2/-/2 | hit |
| pixels | 3 | make it more fun | 28.1s | $0.070 | 2/2/2 | hit |
| emoji | 0 | Chat roulette of emoji ... | 46.4s | $0.091 | 2/2/2 | hit |
| emoji | 1 | add sound effects | 22.5s | $0.063 | 2/2/2 | hit |
| emoji | 2 | make it more fun | 26.2s | $0.068 | 2/2/2 | hit |
| emoji | 3 | this is confusing, make it clearer what to do (pick found nothing) | 14.7s | $0.052 | 2/-/2 | hit |
| kanban | 0 | A kanban board for our hackathon team ... | 30.4s | $0.070 | 2/2/2 | hit |
| kanban | 1 | limit doing to 3 cards and show a warning when it's full | 21.9s | $0.057 | 2/2/2 | hit |
| kanban | 2 | give this column its own color (picked h2) | 9.9s | $0.030 | 2/-/2 | hit |
| kanban | 3 | make it feel calmer | 23.0s | $0.056 | 2/-/2 | hit |

Raw results, served files and source of every version: `/tmp/pg-evals/<run>/`.
