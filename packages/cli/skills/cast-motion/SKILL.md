---
name: cast-motion
description: Make an animated explainer from code and a timeline, published as a codecast page that plays, scrubs, takes comments pinned to moments, can show live numbers, and exports to MP4 on request. Use when asked for a motion piece, an animated explainer, a video of a dashboard or of what the team shipped, or to turn data into a short film.
argument-hint: "[the question the piece answers, or the data to explain]"
---

A motion page is a short film written as HTML: a composition whose every
beat, number and timing is code, published with `cast publish` so people
watch it in the browser, scrub to a moment and comment there. Because it is
code, a comment like "hold on the empty dock a beat longer" is a one-line
edit and a republish, not a re-edit of footage.

## Start from the question and the reveal

Before anything visual, write down the one question a viewer walks in with
and the reveal that answers it. "Why are the hill docks empty by 8:15?" is a
question; "commuters ride downhill in the morning and nobody rides back up"
is its reveal. Every beat exists to make that reveal land: set up what the
viewer expects, show the evidence, turn, reveal, and leave them with what it
means. A piece without a reveal is a slideshow of charts; find the surprising
fact in the data first, and if there is none, say so instead of animating.

## Storyboard before code

Write the beats as a list before writing markup: for each, what the viewer
learns, what is on screen, and how long it holds. Explainers run 30 to 90
seconds; a beat that teaches nothing goes. Durations add up to the whole, and
the reveal gets the most time. Share the storyboard with the person when the
direction is theirs to choose; otherwise build from it.

## Numbers come from real data

Every number on screen comes from a query you ran, and the composition keeps
the source beside the value so a reader of the code can rerun it. Codecast's
own record is the usual source: `cast feed`, `cast search "<topic>" after:7d`,
`cast task ls`, `git log --since`, `cast events ls`, `cast metrics ls`, and a
dashboard's own queries. Never round a number into a better story or invent
one to fill a beat.

When the page has a live data source, bind the number instead of baking it:
`<span data-cast-data="<data id>" data-cast-col="<column>" data-cast-row="-1"
data-cast-format="int">1,204</span>` shows the current value from
`window.cast.data` and follows revisions without a re-render, while the
authored text stays for renders and offline viewers. A script that needs the
value to build a tween (a count up, a bar height) reads it with
`await window.castMotion?.value(id, col, row)` before registering its
timeline, falling back to the authored number.

## The composition contract

This is all the runtime needs; the `hyperframes-core` and
`hyperframes-animation` skills go deeper when they are installed.

- One directory, entry `index.html`. Its root element carries
  `data-composition-id`, `data-width`, `data-height` and `data-duration`
  (seconds), sized `width:100%; height:100%`, never hard pixels.
- Each beat is an element with `data-start` and `data-duration` (a clip). The
  runtime shows a clip only inside its window, so never animate a clip's
  `visibility` or `display`; fade or move its children.
- Exactly one GSAP timeline, created `{ paused: true }` and registered last
  as `window.__timelines["<composition id>"] = tl`. The page's player owns
  play, pause and seek; never call `tl.play()`.
- Every frame is a pure function of time: no `Date.now()`, unseeded random,
  network fetches for visuals, hover state, or infinite repeats.
- Load GSAP from `https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js`
  and do not add the HyperFrames runtime yourself: the page gets the pinned
  one when it is served, and the renderer brings its own.

```html
<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="45">
  <section id="beat-question" class="clip" data-start="0" data-duration="6">…</section>
  <section id="beat-reveal" class="clip" data-start="30" data-duration="15">…</section>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  // tweens, positioned in seconds on the composition's clock
  window.__timelines["main"] = tl;
</script>
```

Keep it steerable: name each beat's element after the beat, put beat starts
and holds in named constants and the data in one block at the top of the
script, so a comment about a moment maps to one obvious line.

## Verify, then publish

Run `npx hyperframes@0.8.142 check <dir>` until it reports no findings, then
`npx hyperframes@0.8.142 snapshot <dir> --at <the midpoint of each beat>` and
look at every frame: text that overflows, a number that reads wrong, a beat
that is empty at its midpoint. Snapshot sends the frames to Gemini for a description whenever `GEMINI_API_KEY` is set; clear it for that command when the frames show private data. Then `cast publish <dir>`, open the page with
`cast browser`, scrub through the beats and screenshot the reveal before
sharing the link.

The page fits the film to the window under a transport: play and pause, a
scrubber with a tick at each beat, frame steps, keys (space, arrows, shift
arrows, comma and period for single frames, 0 to 9 to jump), and `#t=12.5`
links to a moment.

## Steer by comments

Viewers comment on a moment: their comment carries the time it was pinned
at, and it shows as a marker on the scrubber. Read them with `cast publish
comments <slug>`, change the beat each one names, republish the same
directory (the URL and its history stay), and resolve what you addressed. When
a comment asks for something the data does not support, answer it rather than
bend the piece.

## MP4 only on request

Rendering is slow, so publish without it while the piece is being steered.
When someone asks for a file, `cast publish <dir> --render` renders with the
same HyperFrames release, stores the MP4 in the directory's `cast-render/`,
and the page offers a Download MP4 button. A later publish of a changed
directory warns that the MP4 is behind until it is rendered again.

## Codecast-native pieces

- **A week of the team's changes, in 60 to 90 seconds.** The question is
  what actually moved this week. Pull merged work, closed tasks and the
  sessions behind them, pick the three to five changes that matter by their
  effect rather than their size, give each a beat with one real number, and
  end on what the week adds up to.
- **A dashboard as an explainer.** Take the dashboard's own queries, find the
  number that surprises (a spike, a gap, a reversal), and build the film
  toward it: the normal shape first, then the break, then its cause. Bind the
  headline numbers so the film stays current as the dashboard refreshes.
