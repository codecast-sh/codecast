---
name: cast-dashboard
description: Build a live dashboard as a published page over the team's work record (tasks, sessions, spend, pull requests, signals) and its product data (metrics, events, PostHog, connectors). Every chart shows its query and when it last refreshed, and refreshes itself. Use when asked for a dashboard, a live report, a metrics page, or to track how something is going over time.
argument-hint: "[the question the dashboard should answer]"
---

A dashboard is worth building only around a question someone keeps asking:
is the launch working, where does the spend go, are bugs closing faster than
they arrive. Codecast's edge over a generic BI tool is that the product's
numbers and the work behind them sit on one page, so look for the join: a
spike in errors beside the sessions and pull requests that answered it, a
signup metric beside what shipped that week.

## Find the question

Start from what the person asked, and ask once if the question is unclear.
Then look at what data exists before designing anything: `cast sources ls`,
`cast metrics ls`, `cast connector readers <source>`, and the readers in
`cast guide publish` (Dashboards). A chart over data the workspace does not
have is a blank box; leave it out and say what would fill it.

## Pick the queries

Each chart reads one named query in the bundle's `cast-data.json`. Choose
the reader and window that answer the question directly, and the refresh
interval the data actually moves at: spend and tasks change over hours, an
error rate over minutes. Name the workspace when the page is for a team;
otherwise it is the one this session works in, which the publish output
names. Keep the set small: every query is a read that runs again on its
interval while anyone has the page open.

## Lay it out

Lead with the few numbers that answer the question (`<cast-stat>`), then
the trends that explain them (`<cast-chart>` lines, areas, bars), then the
detail someone drills into (tables). Give each a plain title that says what
it measures. The page carries the codecast theme tokens, so style the layout
with them and let the elements inherit; keep the page itself quiet, since
the data is the point.

## Publish and verify

Publish the directory with `cast publish <dir>`. Then check the data, not
the picture: `cast publish data <slug> --refresh` runs every query now and
prints its query text and rows, so an empty result, a wrong window or a
reader error shows up before anyone else sees the page. Open the page in
your browser tab and look at it, and fix what reads wrong before you share
the link.

Team data on a page is visible to anyone holding the link. Gate it
(`--password`, `--email-gate`) unless the person said it may be open, and
say which you chose.

## Steer by comments

Share the URL and invite the person to comment on the page where something
should change. Read the comments (`cast publish comments <slug>`), revise
the queries or the layout, republish to the same URL, and resolve what you
addressed.
