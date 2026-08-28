# Walkie: the five minute run

Two people, one script, five minutes. You hold a face, you talk, the other person
hears you and steps in. This page says what to press, what you should both hear,
and what you should both see at each step. Run it once. Note what felt off.

In this script **you are A** and **your teammate is B**. Where a line quotes a
string that carries a name, the app shows the other person's name in that place.

---

## 1. Setup

Both people: open the desktop app (1.1.96) or Chrome at `codecast.sh`, sign in to
the **same team**, turn sounds on in Settings, and grant the microphone when the
browser asks. Sit in a quiet room with the speakers up; you are judging sound.

Do not wear headphones for the first run. The sounds are tuned to be heard across
a room, and headphones hide a sound that is too quiet.

---

## 2. The run

Read the whole table first. Then run it top to bottom without stopping.

### Act 1: hold a face and talk (0:00 to 0:45)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 1 | **A** presses and holds B's face in the avatar bar. Hold it down. | **A**: one short rising beep. **B**: a two click open, like a radio squelch. | **A**: a warm orange ring on B's face, level bars that move with your voice, and the line `B hears you`. **B**: a strip at the bottom of the screen with A's face, a cool cyan ring on it, and A's name. | [ ] |
| 2 | **A** keeps holding and says one sentence out loud. | **B** hears A's voice from the first word. No clipped start. | **B**: live words appear under the face as A speaks. Above them, the warm line `Your mic is open — A can hear you` with a **Mute** button. Below them, two buttons: **Join live** and **Snooze**. | [ ] |
| 3 | **A** releases the face. | **A**: one short falling beep. **B**: the squelch closes. | **A**: the warm ring goes. **B**: the strip stays where it is, with **Join live** and **Snooze** still on it. | [ ] |

The three things to judge here: the beep on press must arrive before you start
speaking, B must hear the first word and not the second, and B must never be
told that A is talking while B hears silence.

### Act 2: join live (0:45 to 1:30)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 4 | **B** clicks **Join live** on the strip. | Both hear the same join sound: louder than the rest, two notes rising. It must not sound like the call triad. | **A**: `B joined — it's a call now`, for four seconds, then the ordinary title. **B**: `You joined A`, for four seconds. | [ ] |
| 5 | Watch the strip during step 4. Nobody presses anything. | Nothing. | The strip **moves** into the call dock. One shape sliding into another. No flash, no blank frame, nothing disappearing and reappearing. | [ ] |
| 6 | **A** holds B's face again, says a sentence, and releases. | **B** hears the sentence. Neither side hears a close. | **A**: the hot mic line stays after the release. A's microphone is still live, because this is a call now, not a burst. If A goes silent to B after the release, that is the bug this act tests. | [ ] |

### Act 3: the call gets its own window (1:30 to 3:00)

Desktop only. In Chrome, skip to Act 4 and read the limits at the end.

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 7 | **A** clicks **Pop the call out**. | Nothing new. | A window with no title bar, no traffic lights, no grey OS rectangle. Just the call surface. Drag it by its header row. **B** sees no change. | [ ] |
| 8 | **A** clicks **Shrink to a row of faces over your work**. | Nothing. | The window becomes a row of face circles floating over A's other windows. The window is the circles plus a small margin. No empty reserved space around them. | [ ] |
| 9 | **A** clicks **Shrink to one circle: whoever is talking**. | Nothing. | One circle, 96px. At rest it has **no ring and no shadow**. Camera off shows the avatar. No name until A hovers it. | [ ] |
| 10 | **B** speaks for five seconds. | **A** hears B. | **A**: a cyan ring with a glow appears around the circle while B speaks, and goes when B stops. | [ ] |
| 11 | **A** drags the circle to another corner of the screen. | Nothing. | It follows the mouse and stays where it is dropped. It stays on top of other windows. | [ ] |
| 12 | **A** restores the window to the full panel. | Nothing. | The stage comes back with the same call in it. Nobody rejoins, nobody drops. | [ ] |

### Act 4: hang up (3:00 to 3:15)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 13 | **A** hangs up. | **One** quiet close sound, once, on each side. Not two. Not a close followed by a second ended sound a moment later. | The window closes. The dock goes. Neither side is left with a dock for a call that ended. | [ ] |

### Act 5: B is behind another app (3:15 to 3:50)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 14 | **B** brings a different app to the front and covers codecast completely. B stays at the machine and keeps typing. | Nothing yet. | Nothing. | [ ] |
| 15 | **A** holds B's face and says a sentence. | **B hears it out loud**, through the other app. This is the point of the act. **A** hears the ordinary press and release beeps. | **A**: `B hears you`. **B**: the strip appears on top of whatever is in front. | [ ] |
| 16 | **B** walks away from the machine for a minute, then **A** holds and speaks again. | **A** hears a soft tick instead of a live send. **B** hears nothing. | **A**: `B is away — they get the message`. The burst arrives in the DM as a voice message. A was told honestly. | [ ] |

### Act 6: snooze (3:50 to 4:30)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 17 | **A** holds and speaks. **B** clicks **Snooze** while A is still talking. | **B**: the voice stops **now**, mid word. Not at the end of the burst. | **B**: the strip goes. | [ ] |
| 18 | **A** holds and speaks a second time. | **A** hears the soft away tick. **B** hears nothing. | **A**: `B is busy — they get the message`. **B**: the burst is waiting in the DM as an unread message, playable. Snooze lasts one hour. | [ ] |

### Act 7: a brushed tap (4:30 to 5:00)

| # | Who presses what | Both should hear | Both should see | Done |
|---|---|---|---|---|
| 19 | **A** clicks B's face and releases immediately, under about a third of a second. | **Nothing at all**, on either side. | **A**: the DM with B opens. That is what a tap means. **B**: no strip, no sound, no ring. | [ ] |
| 20 | **A** presses B's face for about half a second and releases. Longer than a click, shorter than a sentence. | Nothing sends. | **B**: nothing arrives. **A**: no ring is left behind on the face, and no message is left in the DM. A press too short to carry a word carries nothing. | [ ] |

A keyboard hold is the same gesture. Tab to a face and hold **Space** or
**Enter**. The page must not scroll under you while you hold **Space**.

---

## 3. What felt off

Rate each act with one word: **clear**, **weak**, or **wrong**.

- **clear** means you knew what was happening without thinking about it.
- **weak** means it worked, but you had to look for it or listen for it.
- **wrong** means it did not do what this page says, or it did it badly.

| Act | Rating | What was off |
|---|---|---|
| 1. Hold a face and talk | | |
| 2. Join live | | |
| 3. The call window and the circles | | |
| 4. Hang up | | |
| 5. B behind another app | | |
| 6. Snooze | | |
| 7. A brushed tap | | |

Two more, over the whole run:

| Question | Answer |
|---|---|
| Were the sounds at the right level next to the rest of the app? | |
| At any second, were you unsure whether you were being heard? | |

**How to send this back.** Use the comment button on this page. Write one comment
per act you rated **weak** or **wrong**, and name the act. Comments come straight
back to the session that wrote this page. Do not retype the table.

---

## 4. Known limits, stated honestly

These are expected. Do not report them as bugs.

**Desktop 1.1.96 has no chromeless window yet.** Act 3 needs a build that ships
after this plan. On 1.1.96 the popped out call is an ordinary window with a title
bar and traffic lights, and the size buttons for circles and speaker may not
appear at all. What you can still judge on 1.1.96: that the call moves into its
own window, that the call keeps running through the move, and that closing the
window hands the call back to the main window. Judge the circles on the next
build.

**Mobile has no walkie.** Do not run any act from a phone. The iOS app has calls
but no push to talk, so a face there is a face and nothing else.

**A teammate on a different machine from the one they are signed in on gets the
message only.** The burst plays out loud where the person is at the machine. On
every other machine of theirs it arrives in the DM as a voice message. That is
the design, not a failure, and Act 5 step 16 is the same rule seen from A's side.

**Web is ahead of desktop for Acts 1, 2 and 4 to 7.** All of those work in Chrome
at `codecast.sh` today. If a step fails in the desktop app and passes in Chrome,
say so in the comment; that is a build gap and not a flow bug.
