Dictation done list (the spec):
1. users.dictation_enabled off by default; Settings › Voice "Dictation" switch on web and phone, and palette "Turn on/off dictation" (web); each paints instantly from the store.
2. With dictation off no composer shows a mic, and the server refuses a dictation mint.
3. Mic + language caret (Auto, then languages; remembered per device) in: web session composer and team chat (MessageInput), task comments and comment reply boxes, create-task description; phone session composer, phone chat composer, phone task comments.
4. Pressing the mic starts the microphone at once (buffered while the socket opens); placeholder reads "Listening…"; ✕ (Cancel dictation) and ✓ (Finish dictation) replace the mic and caret. Modelled on Claude's composer.
5. Words land at the cursor (or replace the selection); the sentence in progress rewrites in place; spaces added where needed.
6. ✓ or Enter waits ≤2.5s for the last words; Enter then sends. ✕ or Esc restores the text exactly as before the press.
7. Stops by itself, keeping words, after 60s with no new words or 10 min; only one recording at a time across the app.
8. Mic blocked, mint refused, and a team without an OpenAI BAA each give a clear one-line reason on the mic; nothing breaks.
9. No audio or transcript stored server-side.
10. Typing budget and guard tests stay green; repo rules in CLAUDE.md files hold (store/local-first, UI conventions incl. KeyCap, Themed Text on mobile, native-deps/optionalNative, Metro @/ alias rule).
Shared behaviour lives in packages/shared/contracts/dictation.ts (createDictation); platforms must not re-implement it.
