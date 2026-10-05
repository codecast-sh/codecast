# @platform/fence

Fences foreign text before an agent reads it: the one implementation every
surface uses, so every agent is taught one delimiter and every fence has the
same defenses. Pure TypeScript with no dependencies and no Node built-ins; it
runs in Convex, browsers, React Native and Node.

## Why

Text someone else wrote (an email, a web page, a linked issue, a capability
description) can carry instructions. Escaping markup does not stop "ignore
previous instructions". Provenance does: the text sits inside delimiters that
name where it came from, so the reader treats it as quoted material.

## API

- `fenceForeignText(text, provenance, { maxChars?, note?, nonce? })` wraps
  text in `<untrusted-<nonce> source="...">` ... `</untrusted-<nonce>>`. The
  nonce is fresh per call, so text inside cannot forge the closing tag.
  `maxChars` caps the whole block, delimiters and note included. `note` is a
  trusted line printed above the block. `nonce` fixes the tag for text that is
  fenced again on every replay (keep the prompt cache stable); take it from
  something the text's author cannot see, such as a random id stored with it.
  The provenance is folded to one escaped line.
- `escapeForeignControlChars(text)` makes control, bidi and format characters
  visible (`‮`) instead of active. Tabs become two spaces; newlines stay.
  Fence text after escaping it.
- `capForeignText(text, maxChars)` cuts and marks the cut with `[truncated]`.
- `inlineForeignText(value)` escapes, folds to one line and caps at
  `FOREIGN_TEXT_CAPS.inlineChars`, for titles and authors outside a fence.
- `FOREIGN_TEXT_CAPS`, `FOREIGN_TEXT_TRUNCATION_MARKER`, `fenceNonce()`.

## Tests

`bun test` covers the nonce, the escape set (C0, C1, U+2028/2029, format
characters), provenance folding and the block cap.
