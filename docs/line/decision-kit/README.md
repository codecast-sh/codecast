# The decision page kit

A decision's report page (`cast decide --report page.html`) is where the person deciding sees the thing itself: the real conversation that went wrong, the exact change, what it does to that conversation, and the question. The kit is the page's design, so you write content and no CSS. It is typography first: one reading column, a few wider artifacts, light and dark from codecast's own colours.

Put one line in the page's `<head>`:

```html
<link rel="stylesheet" href="cast:decision-kit">
```

`cast decide --report` and `cast publish` replace that line with the kit, inline, so the published page is one self-contained file. Write the body as plain HTML inside `<main>`, using the pieces below. `example.html` beside this file shows the pieces on invented data.

Look before you post: `cast decide kit page.html --serve` serves the page exactly as it will be published on a local address (it reloads from the file, so keep it running while you write). Open that in the cast browser at a wide and a narrow width, with `?theme=dark` and `?theme=light`, and read it as the person who has to decide. Without `--serve` it writes `page.preview.html` instead.

## What makes a page good

The reader runs the product and does not live in the code, but wants to see the actual prompt or code change. So lead with what a person experienced, in their words and the product's, and show the real artifact wherever a summary would stand in for it. A page that needs its prose to be understood has too little on it; a page of prose has nothing on it.

Size the page to the decision. A one-line change that alters nothing anyone receives is a few screens; a change to what many people get earns more. A piece belongs only if it moves the reader's answer, so no piece is owed to every page.

Everything on the page comes from the record or from something you ran. The after is produced, not described: run the changed code or prompt on the real conversation and show what came out, in the person's own words, for every case the page shows. Never write by hand the message the change "would" send.

What weakens the case is set at the same weight as what supports it, where it bears. A number says what was counted; a claim about what someone felt or waited on is only as strong as the messages that show it.

Nothing is cut. The text the decision turns on (the message at fault, every before and after, changed words a person or an agent meets) is always shown whole; what leads up to it (earlier messages, a long unchanged stretch of a diff) folds, and unfolds in one click. Code is how a change is made, not what it does to anyone, so it never leads: the page is plain language and the pictures of the problem and the fix, and code waits behind one fold.

## The page

```html
<main>
  <header>
    <h1>The headline: what happened to whom, plainly</h1>
    <p>The bottom line: what you would do, and what could make you wrong.</p>
  </header>
  <section><h2>…</h2> …</section>
</main>
```

The page continues the decision card above it: the card carries the question, the recommendation and the answers, and the page holds what the card could not, without telling it again. Its `<header>` is for the page read on its own: the headline that opens the decision's context, short enough to take in at once (also the `<title>`), and the bottom line in a sentence or two. The question belongs to the card. Framed under the card, the kit hides the header, so the first section is where the founder lands: it holds what they would be saying yes to (the fact the decision turns on, and the exact words or rule of the course you lean to), and the evidence follows. Each `<section>` opens with an `<h2>` that says what the section shows; a rule and a breath separate sections. Paragraphs keep to the reading column; threads, pairs, diffs, cases, facts and answers run wider on their own.

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

`us` marks our side. `miss` marks the one message the page is about, `note` says why, and `<mark>` the words that matter, with `note="…"` on a mark when the reason it is marked should be said with it (inside a message the note reads under the message, so the message stays as sent): red inside the message at fault, a neutral highlight anywhere else, so a mark on good new text never reads as a fault. `brief` shows only the paragraphs holding a `<mark>` and folds the rest, for an earlier message in a thread whose bearing on the moment is one line; a message the page leans on (the offer a case broke, the words that prove a claim) is never brief, because the reader must see it all to trust the claim. A message inside a `<dk-side>` is always whole, `brief` or not. `<dk-event>` is anything between messages: a call, a gap, a status change. A short one draws as a marker between rules; a long one reads as a sentence at full size, so a fact the decision turns on can sit there. The thread shows its last `show` items (always from the first message holding the miss or a `<mark>` on) and folds the earlier ones, so a message that proves a claim, such as the offer a refusal broke, carries a mark and stays in view; a long message folds too unless it carries `full`.

**Before and after.** What a person received, and what they would receive. Side by side when wide, stacked when narrow.

```html
<dk-pair>
  <dk-side label="What she got, at 7:58 pm"><dk-msg from="…" channel="Text">…</dk-msg></dk-side>
  <dk-side label="With the change, at 5:30 pm"><dk-msg from="…" channel="Text">…</dk-msg></dk-side>
</dk-pair>
```

A message's `time` is read as when the person received it, so a line inside a call carries its place in the call in words, not a clock time that reads as midnight.

A side holds anything: a message, a `<dk-event>` for an outcome that is not a message (a booking made, nothing sent), a paragraph, a `<dk-gap>`. In a side, each item is a slot of its own, so several runs of one moment read as a list: an outcome that is not a message is framed like the messages beside it, never as a divider.

**A screen.** When the change alters something people see in the product, the picture of it is a screenshot of the product itself, never text or markup drawn to stand for it. Run the product as it was and as changed, on the same records, and capture the same screen from both; `cast image` (or `cast browser shot --share`) turns a capture into the address `src` takes. Capture at a width the screen is really used at and clip to the part the decision is about, so it still reads on a phone. Two or more shots of one screen share a frame and flip by their labels, so the change reads in place; one shot stands alone, and either sits in a case or a side like any other piece.

```html
<dk-shots>
  <figcaption>Evals, Cases grid, the same 30 runs</figcaption>
  <dk-shot label="Today" src="https://…" alt="What the screen shows">What to look at, in a line.</dk-shot>
  <dk-shot label="With the change" src="https://…" alt="…">…</dk-shot>
</dk-shots>
<dk-shot label="The page a person lands on" src="https://…" alt="…"></dk-shot>
```

A shot opens full size in one tap. Its text, when it has any, says what to look at.

**Nothing on record.** The honest state of a slot that could not be filled, for a case the decision does not turn on. When the empty slot is the one the decision turns on, the gap is the question, asked on the card, not a box on the page.

```html
<dk-gap><b>No rewritten email exists</b> What was and was not run, and what the record does show.</dk-gap>
```

**A diff.** Show a change as the words its reader meets: the sentences a model is given, the message a person gets. When those words come out of a template or code, diff the text as rendered for the case at hand (a rendered snapshot the repository keeps, or one you render), not the source that produces it. An unchanged line that still pulls against the change is part of what the founder decides. The paragraph touching each change stays in view (folded in its middle when long) and every other unchanged paragraph waits behind one button, so a sentence changed in a long prompt reads as that sentence, with the whole prompt a click away. Paste the whole text's diff and let the kit fold it. An unchanged line the page talks about anywhere else is quoted right under the diff.

```html
<dk-diff>
  <figcaption>The instructions the follow-up writer is given</figcaption>
  <template data-before>The rendered text on main.</template>
  <template data-after>The rendered text on the branch.</template>
</dk-diff>
```

The kit diffs the two line by line in one convention: removed words struck, added words lit, kept words plain. An addition shows only the added lines, under the kept line it follows; an edited line shows its changed words in place. Name the box with a `<figcaption>` in words, or `file="path"` for a path. Prose reflows as markdown does, so paste it as the source has it. Paste the whole rendered text on both sides, never placeholders for the parts that did not change.

Pasted `git diff` output works too, for files that are already the words themselves and for code: prose reads as running text with the changed words marked and long unchanged stretches folded. Code always renders folded, under one line naming the files (or the `<figcaption>`) and how many lines changed, and opens to lines that wrap, with the changed words marked inside them. The kit picks by file type; `as="prose"` or `as="code"` overrides.

```html
<dk-diff>
<script type="text/plain">
diff --git a/jobs/reminders.ts b/jobs/reminders.ts
…the diff, untouched…
</script>
</dk-diff>
```

A change appears once on the page as what it does: the rendered words, or what the code makes a person receive, before and after. The code itself is optional, one folded diff of the lines that carry the change, never a second telling of it; fixtures, tests and file lists stay out, since the decision's run link holds them.

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

A case may hold a `<dk-msg>`, a `<dk-pair>`, a `<dk-gap>`, a `<dk-shot>` or `<dk-shots>`, or a `<dk-view>`.

**Facts.** A number set large is read as measured, so only a number that was counted gets one, with what it counts and out of how many. Facts in one strip are read as like for like, so they share one strip only when they count the same thing the same way. A fact is set in ink, never coloured: what a count means for people is said in its words, which read at a glance (what it counts, out of what); whatever more it needs belongs in the page's text.

```html
<dk-facts>
  <dk-fact><b>41 of 41</b> September reminders arrived after the doors opened</dk-fact>
  <dk-fact><b>41 of 41</b> arrive before the doors open, the same reminders replayed on the change</dk-fact>
</dk-facts>
```

**A quote.** A person's own words, set apart: a customer, a reviewer. Text from a file (a prompt, a rule, a template, code) is not a quote: show it as it stands in `<pre>`, with `<mark>` on the words that matter, or in the diff.

```html
<blockquote>The words.<cite>Who said it, about what</cite></blockquote>
```

**A line each.** A few terms the reader needs read side by side, each a short name beside what it is; the value gets the width, and on a phone the name sits above it. The decision's case (proof, reach, risk) is argued on the card, not restated here.

```html
<dl>
  <dt>Term</dt><dd>What it is.</dd>
</dl>
```

**A table.** A few rows of counts read across, as a plain `<table>` with `<th>` headers; the first column names the row and the rest are numbers. Every header and row label says, in the founder's words, which version a person met and what happened to them; a cell is one count out of its whole. On a phone a table of three or more columns stacks each row under its name, a label and value per column, so every column stays in view.

**A grid of results.** A grid of passes and fails that no screen shows (results the page works out itself, a check's history read from logs) is drawn as cells, never as letters in `<pre>`; a grid people see on a screen is that screen, shot. Each row is one case, named whole by what tells it apart, its cells one letter each (`P` pass, `F` fail, `.` not run, oldest first) and its `note` the count it is sorted by. Before and after are two grids over the same rows.

```html
<dk-cells>
  <figcaption>Today: the 5 cases that flip most, newest 30 runs</figcaption>
  <dk-row name="Search status, when the carrier answers late" note="8 flips">..P.F..PF</dk-row>
</dk-cells>
```

**A caveat** the reader must not miss: `<dk-caveat><b>Not checked:</b> …</dk-caveat>`.

**The thing itself, in the product.** A link that opens the product's own view of a record, whole: a conversation, a person, a call, a match, a need.

```html
<dk-view ref="union:conversation/<contact uuid>@2026-10-08T00:56:00Z">Open her whole conversation in Union</dk-view>
```

`ref` is `<app>:<view>/<id>`, with `@<ISO time>` to show a conversation as it stood at that moment. The link opens codecast's `/view` page, which frames the app's screen for the signed-in reader. The same reference alone on a line of the decision's `--context` markdown draws the view inline there. `href` replaces the link with one of your own. Inside a sentence, a list item or a table cell a view is an inline link.

**The people behind a count.** Who a count is made of, grouped by what happened to each, every one a click from their whole conversation. The kit counts each group's people and sets the number above its heading, and `of` names the whole, so a count on the tally is always the number of people it lists. Each group reads as a band, its people in even columns, and a long group shows its first few with the rest one click away. Put a person in exactly one group; a few words after their name say what decides their group. Reach, coverage and the people a change misses read here, not as a paragraph of names.

```html
<dk-tally of="flagged conversation rerun" of-many="flagged conversations rerun">
  <dk-group>
    <h3>Named what was waiting on them</h3>
    <ul>
      <li><dk-view ref="union:conversation/<uuid>@2026-10-01T14:48:00Z">Ines Okafor</dk-view> the dinner seating she asked about</li>
    </ul>
  </dk-group>
  <dk-group>
    <h3>Still only said we called</h3>
    <ul><li><dk-view ref="…">Tomas Reyes</dk-view> nothing was open</li></ul>
  </dk-group>
</dk-tally>
```

**Answers.** The decision's options are drawn once, by the decision card around the page, so a page posted with `cast decide --report` ends on what makes the question open and what you would do, and carries no answers of its own. `<dk-answers>` is for a page read on its own: the decision's options in the same order, `lean` on the one you would pick.

```html
<dk-answers>
  <dk-answer lean><h3>Ship the timing and the wording</h3> What happens if chosen.</dk-answer>
  <dk-answer><h3>Something else</h3> Tell me what, and I rework it.</dk-answer>
</dk-answers>
```

## Real data

A page built from real conversations is published, never committed: this repository is public. Write it in the run's own directory.
