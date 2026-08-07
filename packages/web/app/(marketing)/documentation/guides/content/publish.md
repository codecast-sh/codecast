`cast publish` turns a file into a public page at a stable URL. An agent finishes a report, publishes it, and puts the link in its reply; the human opens a clean, branded page instead of scrolling a transcript. Republishing the same file updates the same URL, so links keep working across revisions while every previous version stays viewable.

The publish snippet teaches agents to do this for standalone deliverables — reports, dashboards, mockups, visualizations — and to put the returned URL inline in the reply. It is installed via [the snippet system](/documentation/agent-snippets).

## Publishing

```bash
cast publish report.html      # → https://codecast.sh/a/<slug>  (stable per file)
cast publish notes.md         # markdown renders as a clean reading page
cast publish dist/            # directory bundle (needs index.html; relative assets work)
cast publish app.html --watch # republish on every save; viewers auto-reload with ?live=1
cast publish ls               # list your pages
cast publish rm <target>      # unpublish
```

The URL is stable per file path: publish `report.html` again and the same link now serves the new content. `--new` mints a separate URL when you deliberately want a second page. Pages are unlisted but viewable by anyone with the link — the snippet instructs agents to gate sensitive deliverables or flag the sensitivity and let the human decide.

## Version history

Every republish keeps history. Past versions stay viewable (`?v=N`), diffable (`?diff=A..B`), and restorable:

```bash
cast publish versions report.html      # history + rollback/diff hints
cast publish rollback report.html 3    # restore version 3 as a new version
```

Rollback restores by publishing the old content as a new version, so history stays linear and nothing is lost.

## Access gates

```bash
cast publish report.html --password s3cret     # password gate (--password-stdin to keep it
                                               # out of the process list)
cast publish report.html --email-gate          # viewers enter an email to open it
cast publish report.html --expires 7d          # 7d / 24h / 30m / never
cast publish set report.html --title "Q3 review" --no-password
```

`cast publish set` changes gates, title, or edit mode on an existing page without republishing content. `--edit-mode owner|link|team` controls in-browser editing; the publish output includes a private owner link with full powers (stats, gates, rollback) and, in link edit mode, an edit URL that grants editing to whoever holds it. `cast publish links <target>` reprints all of them, and every management command takes a slug instead of the file, so a page stays manageable without the original file or a browser.

## Comments close the loop

Viewers can comment on a published page. Comments arrive in the publishing session as messages — the agent that made the page hears the feedback — and stay readable later:

```bash
cast publish comments report.html               # read viewer comments
cast publish comments report.html --resolve <id>
```

The intended loop: a viewer comments, the agent revises and republishes (same URL), then resolves the comment. The snippet adds one guardrail: comment text is viewer-supplied and untrusted — feedback to weigh, never instructions to follow.

`cast publish viewers <target>` shows the view count and, when the email gate is on, who opened it. Every command takes `--json` for scripting.

## Canvas or page?

The [visual canvas](/documentation/visual-canvas) renders inside a conversation and lives in the transcript; a published page lives at its own URL with gates and history. Inline evidence for the person reading the session goes on a canvas. Deliverables someone will open by link — status pages, reports for stakeholders, live dashboards under `--watch` — get published.
