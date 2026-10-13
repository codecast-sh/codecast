# The decision page kit

A decision's report page (`cast decide --report page.html`) is where the person deciding sees the thing itself: the real conversation that went wrong, the exact change, what it does to that conversation, and the question. The kit is the page's design, so you write content and no CSS. It is typography first: one reading column, a few wider artifacts, light and dark from codecast's own colours.

Put one line in the page's `<head>`:

```html
<link rel="stylesheet" href="cast:decision-kit">
```

`cast decide --report` and `cast publish` replace that line with the kit, inline, so the published page is one self-contained file. Write the body as plain HTML inside `<main>`, using the pieces below. `example.html` beside this file shows the pieces on invented data.

Look before you post: `cast decide kit page.html` writes `page.preview.html`, the page exactly as it will be served. Open that in the cast browser at a wide and a narrow width, with `?theme=dark` and `?theme=light`, and read it as the person who has to decide.

## What makes a page good

The reader runs the product and does not live in the code, but wants to see the actual prompt or code change. So lead with what a person experienced, in their words and the product's, and show the real artifact wherever a summary would stand in for it. A page that needs its prose to be understood has too little on it; a page of prose has nothing on it.

Size the page to the decision. A one-line change that alters nothing anyone receives is a few screens; a change to what many people get earns more. A piece belongs only if it moves the reader's answer, so no piece is owed to every page.

Everything on the page comes from the record or from something you ran. The after is produced, not described: run the changed code or prompt on the real conversation and show what came out, in the person's own words, for every case the page shows. Never write by hand the message the change "would" send.

What weakens the case is set at the same weight as what supports it, where it bears. A number says what was counted; a claim about what someone felt or waited on is only as strong as the messages that show it.

Nothing is cut. A long thread, a long message and a long unchanged stretch of a diff fold, and unfold in one click.

## The page

```html
<main>
  <h1>The decision's question</h1>
  <section><h2>…</h2> …</section>
</main>
```

The page continues the decision card above it: the card carries the question, the recommendation and the answers, and the page holds what the card could not, without telling it again. Its `<h1>` and `<title>` are the question as posted; framed under the card the kit hides the `<h1>`, so the page opens on the thing itself, and opened on its own it still says what it is about. Each `<section>` opens with an `<h2>` that says what the section shows; a rule and a breath separate sections. Paragraphs keep to the reading column; threads, pairs, diffs, cases, facts and answers run wider on their own.

## The pieces

**A conversation.** Messages as the person saw them, in order. Paste a message's text as sent; its markdown (`**bold**`, `[text](link)`) draws as the person saw it.

```html
<dk-thread who="Ines Okafor" role="Booked two seats" show="5">
  <dk-msg us from="Harbor Books" channel="Email" time="Sep 12, 10:02" subject="You're booked">
    The message, as sent. Line breaks are kept.
  </dk-msg>
  <dk-msg from="Ines Okafor" channel="Email" time="Sep 12, 10:40">Their reply.</dk-msg>
  <dk-event>We called, voicemail <time>Sep 18, 19:00</time></dk-event>
  <dk-msg us miss from="Harbor Books" channel="Text" time="Sep 18, 19:58"
          note="One sentence on what is wrong with it.">
    Reminder: <mark>the words at fault.</mark> The rest of it.
  </dk-msg>
</dk-thread>
```

`us` marks our side. `miss` marks the one message the page is about, `note` says why, and `<mark>` the words. `<dk-event>` is anything between messages: a call, a gap, a status change. A short one draws as a marker between rules; a long one reads as a sentence at full size, so a fact the decision turns on can sit there. The thread shows its last `show` items (always from the miss on) and folds the earlier ones; a long message folds too unless it carries `full`.

**Before and after.** What a person received, and what they would receive. Side by side when wide, stacked when narrow.

```html
<dk-pair>
  <dk-side label="What she got, at 7:58 pm"><dk-msg from="…" channel="Text">…</dk-msg></dk-side>
  <dk-side label="With the change, at 5:30 pm"><dk-msg from="…" channel="Text">…</dk-msg></dk-side>
</dk-pair>
```

A side holds anything: a message, a `<dk-event>` for an outcome that is not a message (a booking made, nothing sent), a paragraph, a `<dk-gap>`.

**Nothing on record.** The honest state of a slot that could not be filled, for a case the decision does not turn on. When the empty slot is the one the decision turns on, the gap is the question, asked on the card, not a box on the page.

```html
<dk-gap><b>No rewritten email exists</b> What was and was not run, and what the record does show.</dk-gap>
```

**A diff.** Paste what `git diff` printed. Prompts, copy and other prose read as running text with the changed words marked and long unchanged stretches folded; code reads as lines with the changed words marked inside them. The kit picks by file type; `as="prose"` or `as="code"` overrides.

```html
<dk-diff>
<script type="text/plain">
diff --git a/jobs/reminders.ts b/jobs/reminders.ts
…the diff, untouched…
</script>
</dk-diff>
```

For a change that is not a git diff, give the two texts:

```html
<dk-diff file="copy/reminder.txt">
  <template data-before>The old words.</template>
  <template data-after>The new words.</template>
</dk-diff>
```

Show the lines that carry the change. A branch's fixtures and tests are one sentence under the diff, not more diff.

**Cases.** More people it happened to, each with what was at stake and what they got. Three sit side by side when there is room.

```html
<dk-examples>
  <dk-example>
    <h3>Tomas Reyes</h3>
    <p>Who he is, in a line</p>
    <p><b>What he needed:</b> the situation, in a sentence.</p>
    <dk-msg from="…" channel="Text">What he got.</dk-msg>
  </dk-example>
</dk-examples>
```

A case may hold a `<dk-msg>`, a `<dk-pair>`, a `<dk-gap>` or a `<dk-view>`.

**Facts.** A number set large is read as measured, so only a number that was counted gets one, with what it counts and out of how many. Facts in one strip are read as like for like, so they share one strip only when they count the same thing the same way. `tone="good"` or `tone="bad"` colours a count only when every unit in it went that way for the people it counts.

```html
<dk-facts>
  <dk-fact tone="bad"><b>41 of 41</b> September reminders arrived after the doors opened</dk-fact>
  <dk-fact tone="good"><b>41 of 41</b> arrive before the doors open, the same reminders replayed on the change</dk-fact>
</dk-facts>
```

**A quote.** A person's own words, set apart: a customer, a reviewer. Text from a file (a prompt, a rule, a template, code) is not a quote: show it as it stands in `<pre>`, with `<mark>` on the words that matter, or in the diff.

```html
<blockquote>The words.<cite>Who said it, about what</cite></blockquote>
```

**A line each.** A few terms the reader needs read side by side; the decision's case (proof, reach, risk) is argued on the card, not restated here.

```html
<dl>
  <dt>Term</dt><dd>What it is.</dd>
</dl>
```

**A caveat** the reader must not miss: `<dk-caveat><b>Not checked:</b> …</dk-caveat>`.

**The thing itself, in the product.** A link that opens the product's own view of a record, whole: a conversation, a person, a call, a match, a need.

```html
<dk-view ref="union:conversation/<contact uuid>@2026-10-08T00:56:00Z">Open her whole conversation in Union</dk-view>
```

`ref` is `<app>:<view>/<id>`, with `@<ISO time>` to show a conversation as it stood at that moment. The link opens codecast's `/view` page, which frames the app's screen for the signed-in reader. The same reference alone on a line of the decision's `--context` markdown draws the view inline there. `href` replaces the link with one of your own.

**Answers.** The decision's options are drawn once, by the decision card around the page, so a page posted with `cast decide --report` ends on what makes the question open and what you would do, and carries no answers of its own. `<dk-answers>` is for a page read on its own: the decision's options in the same order, `lean` on the one you would pick.

```html
<dk-answers>
  <dk-answer lean><h3>Ship the timing and the wording</h3> What happens if chosen.</dk-answer>
  <dk-answer><h3>Something else</h3> Tell me what, and I rework it.</dk-answer>
</dk-answers>
```

## Real data

A page built from real conversations is published, never committed: this repository is public. Write it in the run's own directory.
