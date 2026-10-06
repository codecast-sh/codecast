Computer-use agents usually work from screenshots and pixel coordinates, and they need the screen to themselves: they move your mouse, steal focus and type into whatever window is in front. Codecast works from the other end. The agent reads one native window as a list of named elements, acts on an element by name, and reports exactly what changed, all in a window behind the one you are using. Preview, Slack, System Settings or a save dialog are in reach without the agent taking your screen. Inside a web page the agent uses your browser instead.

![A desktop with Preview showing Lease renewal.pdf, the Sign toolbar button outlined and labelled 41 button Sign, an orange agent cursor over the document, and a Notes window in front where a black cursor is labelled you, still typing. A terminal on the right shows cast computer find --app com.apple.Preview Sign and its tree output.](/blog/field-manual/computer-hero.webp "The agent works in Preview (orange pointer) while you keep typing in Notes (black pointer). On the right, the line of the window it acts on: `41 button Sign`.")

## What you see on your Mac

Mostly, nothing changes. No window comes forward on its own. Presses, field values and menu actions reach the app through macOS accessibility in the background, and typing goes into the target app's own queue, never the app you are typing in.

What you do see is an orange **agent** pointer that glides to each action and pulses on the press, drawn over the screen without taking focus. Your black pointer stays where you left it.

![Spotify in the background with an orange agent pointer on a row, Mail in front with the user's black pointer; text explains the orange pointer is the agent and that --restore-window is the one flag that raises the target window.](/blog/field-manual/computer-screen.webp "The agent cursor in a background app while your own pointer stays in Mail.")

A few controls answer only a real mouse (a drag, say), which macOS drops on background windows. Only then does the agent bring the window forward, and your pointer returns to where it was.

## A window, read as text

The agent gets a window back as lines: a number, a role, a name and the extra actions an element offers (`41 button Sign, Secondary Actions: show menu`), or just the matches for "Sign". A number from before a scroll or navigation fails cleanly instead of clicking whatever sits there now.

## Verified versus attempted

Delivered is not the same as taken, so every action reports a verdict and the lines of the window that changed. A value the agent set can be read back, so it reads **completed**. macOS cannot confirm that a press did what a button promises, so a click reads **attempted**, and the diff under it is the evidence: in Preview, pressing Sign added a popover with a saved signature and a Create Signature button, along with the numbers to use next. An action the app ignored says **No change**, and the agent knows not to assume it worked.

![Three verdict cards: set-value completed (read back and confirmed), click attempted (delivered, and here is the evidence), ignored click No change. Beside them, the click command's output with the three added tree lines and the JSON verification state unverified, reason accessibility_action_unasserted.](/blog/field-manual/computer-changes.webp "Each action reports its own verdict and its diff. &quot;Attempted&quot; with a diff is normal for a press; only a read-back earns &quot;verified&quot;.")

These rows land in the conversation like any other step, with screenshots, so you can review what it did without having watched.

## Built for a machine with your life on it

Some limits are enforced where they cannot be talked around. Password managers (1Password, Bitwarden, Dashlane, LastPass, NordPass, Proton Pass) are refused outright, under any name, and no setting turns that off. Password, passcode and one-time-code fields always read as `[redacted]`, so their values never reach the agent or the transcript. And every agent carries the same standing rule: reading is the agent's to do; sending, submitting, buying, deleting or changing settings waits for you to ask.

![Dark cards: Password managers are refused (app_blocked) with six struck-through app names; Secret fields never print, showing a secure text field Value (redacted); Secrets go in through stdin. Below, the behaviour rule table: agent does read a window, find a button, write a draft, take a screenshot, report what it saw; waits for you to ask send a message, submit a form, buy anything, delete data, change settings.](/blog/field-manual/computer-safety.webp "Refusals live in the helper itself, not in anything an agent can switch off. The behaviour rule is in every agent's instructions.")

Setup is two macOS grants, Accessibility and Screen Recording, given once to a small signed helper app rather than to your terminal. The desktop app's settings show both beside the microphone and camera and open the pane for whichever is missing. Linux under X11 works the same way; Windows does not yet.

> **Why it matters.** Reading the accessibility tree instead of pixels makes desktop actions cheap, named and checkable, and that is what lets them run in the background: the agent does not need to see the screen, so it does not need to own it. The honest verdicts (verified, attempted, no change) give the agent a way to know an app ignored it, instead of assuming a click worked.
