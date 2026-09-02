# Walkie: the five minute run

Two people, one script, five minutes. You click a face, you talk, the other person
sees you and hears you. They hear you; you do not hear them until they step in.
This page says what to press, what you should both hear, and what you should both
see at each step. Run it once. Note what felt off.

In this script **you are A** and **your teammate is B**. Where a line quotes a
string that carries a name, the app shows the other person's name in that place.

There is no hold gesture any more. Talk is a click to start and a click to stop.

---

## 1. Setup

Both people: open the desktop app (1.1.99) or Chrome at `codecast.sh`, sign in to
the **same team**, turn sounds on in Settings, and grant the microphone when the
browser asks. Sit in a quiet room with the speakers up; you are judging sound.

Do not wear headphones for the first run. The sounds are tuned to be heard across
a room, and headphones hide a sound that is too quiet.

---

## 2. The run

Read the whole table first. Then run it top to bottom without stopping.

### Act 1: click a face and talk (0:00 to 0:50)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 1 | **A** clicks B's face in the avatar bar. | Nothing. A click on a face sends nothing. | **A**: three labelled buttons appear under the face: **Talk**, **Ring**, **Message**, with B's name above them. **B**: nothing. | [ ] |
| 2 | **A** clicks **Talk**. | **A**: one short rising chirp the moment the mic opens. **B**: a two click open, like a radio squelch. | **A**: a card in the corner. Its badge reads `OPENING MIC` for a beat, then `RECORDING`, then `TALKING` once B's machine is hearing it. Under the badge: `B sees you and hears you. You will not hear them until they JOIN. Click STOP when you are done.` A warm ring on B's face moves with your voice, and the face's button now reads **Stop**. **B**: a card with A's face, a cool ring on it, the badge `INCOMING`, and the line `A is talking to you. You hear them; they cannot hear you.` Below it: **Talk back**, **Join live**, **Snooze 1h**. | [ ] |
| 3 | **A** says two sentences out loud. **B** says one sentence back. | **B** hears A from the first word, no clipped start. **A hears nothing from B.** That is the design: a walkie is one way until B joins. | **B**: live words appear on the card as A speaks. **B's card must never say A can hear them.** There is no "your mic is open" line on B's side, because B's mic is shut. | [ ] |
| 4 | **A** clicks **Stop talking** on the card. | **A**: one short falling beep. **B**: the squelch closes. | **A**: the card goes. Stop means the card goes; nothing is left in the corner. **B**: the card stays. Its badge reads `THEY STOPPED` and the line reads `A just talked to you. TALK to answer, or JOIN LIVE to talk back and forth.` The burst is in the DM as a voice message with its words. | [ ] |

The three things to judge here: the chirp must arrive before you start speaking,
B must hear the first word and not the second, and B must never be told that A
can hear them.

### Act 2: join live (0:50 to 1:40)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 5 | **B** clicks **Join live**. | Both hear the same join sound: louder than the rest, two notes rising. It must not sound like the call triad. | **A**: `B joined — it's a call now`, for four seconds. **B**: `You joined A`, for four seconds. Then both cards read `ON THE LINE` with the line `Hands free. A hears everything you say. Press END to hang up.` (each side sees the other's name). Both cards carry **Mute**, **End — hang up**, and **Float faces over my work**. | [ ] |
| 6 | Watch the card during step 5. Nobody presses anything. | Nothing. | The card **changes shape in place**. One thing becoming another. No flash, no blank frame, nothing disappearing and reappearing. | [ ] |
| 7 | **B** says a sentence. Then **A** says one. | **A hears B for the first time.** This is the moment B's microphone opened. **B** hears A without A pressing anything: A's mic stayed open through the join. | Neither side needs a Talk or a Stop. If A has to press anything to be heard, or A went silent to B at the join, that is the bug this act tests. | [ ] |

### Act 3: the call floats over your work (1:40 to 3:00)

Desktop only. In Chrome, skip to Act 4 and read the limits at the end.

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 8 | **A** clicks **Float faces over my work** on the card. | Nothing new. | The call leaves the main window and opens straight into circles: face circles floating over A's other windows, no title bar, no traffic lights, no grey OS rectangle. The window is the circles plus a small margin. **B** sees no change. | [ ] |
| 9 | **A** hovers the circles and reads the size buttons. | Nothing. | Three named sizes: **All faces**, **Who's talking**, **Tiny**. Every button has a word on it. | [ ] |
| 10 | **A** picks **Who's talking**. | Nothing. | One circle. At rest it has **no ring and no shadow**. Camera off shows the picture. No name until A hovers, and then the name sits **under** the face, with the controls in a row below it, never over anyone's face. | [ ] |
| 11 | **B** speaks for five seconds. | **A** hears B. | **A**: a cyan ring with a glow appears around the circle while B speaks, and goes when B stops. | [ ] |
| 12 | **A** picks **Tiny**. | Nothing. | One circle the size of a menu bar icon. Still on top of other windows. | [ ] |
| 13 | **A** drags a circle to another corner of the screen. | Nothing. | It follows the mouse and stays where it is dropped. It stays on top. | [ ] |
| 14 | **A** clicks the button titled **Back to the full call window**. | Nothing. | The stage comes back with the same call in it. Nobody rejoins, nobody drops. | [ ] |

### Act 4: hang up (3:00 to 3:20)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 15 | **A** clicks **End — hang up**. **B** presses nothing. | **One** quiet close sound, once, on each side. Not two. | **A**: the call window closes and the card goes. **B**: within about four seconds B's side ends on its own. A huddle you leave goes away on the other side as well; B must not be left sitting alone in a room with an End button. | [ ] |

### Act 5: B is behind another app (3:20 to 3:55)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 16 | **B** brings a different app to the front and covers codecast completely. B stays at the machine and keeps typing. | Nothing yet. | Nothing. | [ ] |
| 17 | **A** clicks B's face, clicks **Talk**, says a sentence, clicks **Stop talking**. | **B hears it out loud**, through the other app. This is the point of the act. **A** hears the chirp and the falling beep. | **A**: `B hears you` on the card. **B**: the card appears on top of whatever is in front. | [ ] |
| 18 | **B** walks away from the machine for three minutes, then **A** talks again. | **A** hears a soft tick instead of a live send. **B** hears nothing. | **A**: `B is away — they get the message`. The burst arrives in the DM as a voice message. A was told honestly. | [ ] |

### Act 6: snooze (3:55 to 4:30)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 19 | **A** talks. **B** clicks **Snooze 1h** while A is still talking. | **B**: the voice stops **now**, mid word. Not at the end of the burst. | **B**: the card goes. | [ ] |
| 20 | **A** talks a second time. | **A** hears the soft away tick. **B** hears nothing. | **A**: `B is busy — they get the message`. **B**: the burst is waiting in the DM as an unread message, playable. Snooze lasts one hour. | [ ] |

### Act 7: the face menu, and a talk too short to carry a word (4:30 to 5:00)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 21 | **A** clicks B's face, then clicks **Message**. | **Nothing at all**, on either side. | **A**: the DM with B opens. **B**: no card, no sound, no ring. Clicking a face never opens a microphone. | [ ] |
| 22 | **A** clicks B's face, clicks **Talk**, and clicks **Stop** within half a second. | **A** may hear the chirp. **B** hears nothing. | **B**: nothing arrives. **A**: no ring is left on the face and no message is left in the DM. A talk too short to carry a word (under about 0.7 seconds) carries nothing. | [ ] |
| 23 | **A** clicks B's face and presses **Escape**. | Nothing. | The three buttons close. | [ ] |

The keyboard is the same toggle. In an open DM, **Ctrl Shift Space** starts a
talk, and pressing it again stops it. The **Talk** button in the DM header does
the same.

---

## 3. What felt off

Rate each act with one word: **clear**, **weak**, or **wrong**.

- **clear** means you knew what was happening without thinking about it.
- **weak** means it worked, but you had to look for it or listen for it.
- **wrong** means it did not do what this page says, or it did it badly.

| Act | Rating | What was off |
|---|---|---|
| 1. Click a face and talk | | |
| 2. Join live | | |
| 3. The call floats over your work | | |
| 4. Hang up | | |
| 5. B behind another app | | |
| 6. Snooze | | |
| 7. The face menu | | |

Three more, over the whole run:

| Question | Answer |
|---|---|
| Were the sounds at the right level next to the rest of the app? | |
| At any second, were you unsure whether you were being heard? | |
| At any second, did you think the other person could hear you when they could not, or the reverse? | |

**How to send this back.** Use the comment button on this page. Write one comment
per act you rated **weak** or **wrong**, and name the act. Comments come straight
back to the session that wrote this page. Do not retype the table.

---

## 4. Known limits, stated honestly

These are expected. Do not report them as bugs.

**Act 3 needs desktop 1.1.99.** The chromeless floating window ships in that
build. On 1.1.96 the popped out call is an ordinary window with a title bar and
traffic lights, and the size buttons may not appear. If the app has not updated,
judge Acts 1, 2 and 4 to 7 and leave Act 3 for the next run.

**Mobile has no walkie.** Do not run any act from a phone. The iOS app has calls
but no push to talk, so a face there is a face and nothing else.

**A teammate on a different machine from the one they are sitting at gets the
message only.** The burst plays out loud where the person is at the machine. On
every other machine of theirs it arrives in the DM as a voice message. That is
the design, not a failure, and Act 5 step 18 is the same rule seen from A's side.

**Ring is not in this run.** The **Ring** button under a face starts a real
huddle, both ways, with a ring on B's side. It is a different thing from a
walkie and gets its own run.

**Web is ahead of desktop for Acts 1, 2 and 4 to 7.** All of those work in Chrome
at `codecast.sh` today. If a step fails in the desktop app and passes in Chrome,
say so in the comment; that is a build gap and not a flow bug.
