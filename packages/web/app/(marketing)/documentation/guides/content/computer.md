Some work isn't in a web page at all. It is in Preview, Slack, Mail, System Settings, an installer, a file picker, or the desktop build of the app you are making. With Computer use on, your agents work in those apps the way you would: they read the window, find the button by its name, click, type, and tell you what happened.

They do it in the background. The agent works in a window behind the one you are using, an orange pointer shows you where it acts, and your own pointer and keyboard stay yours. You can keep writing an email while an agent fills in a form in another app.

![A conversation where the agent used Calculator and read System Settings](/documentation/computer/conversation.webp "Asked to work out a sum in Calculator and check Bluetooth and the sound output in System Settings. Each step sits above the reply with a picture of the window the agent read, and it changed nothing it wasn't asked to.")

## Turn it on

Computer use runs on a Mac with codecast connected ([Getting started](/documentation#getting-started) covers connecting a computer).

1. Open **Agent features** from your account menu and pick the Mac your agents run on.
2. Switch on **Computer**, under *Hands on the machine*.
3. The card asks for two macOS permissions. Click **Open System Settings** and turn on **codecast computer** under **Accessibility**, then under **Screen Recording**.
4. The card turns green and reads *Accessibility and Screen Recording granted*.

![The Computer feature's detail: what you'll see, when agents use it, and a request to try](/documentation/computer/computer-feature.webp "The Computer detail in Agent features. The switch at the top right turns it on for the selected Mac.")

Accessibility lets the agent read a window and click, type and scroll in it. Screen Recording lets it take a picture of the window it is reading. Without Screen Recording it can still work, it just can't show you or itself what the window looks like.

The permissions go to a small codecast helper app, not to your terminal, so granting them doesn't hand the same access to everything else you run there. You grant them once; they survive codecast updates. If an agent needs the permissions before you've granted them, the same steps appear as a card under its step in the conversation, with a **Tell the agent to continue** button once they're on.

## Ask for it in plain words

Name the app and say what you want:

- "Sign the lease in Preview with my saved signature. Don't save or send it."
- "Pick the export folder in the save dialog."
- "Check that the desktop build shows the new settings pane, and send me a screenshot."
- "Is Bluetooth on, and which microphone is selected?"
- "Open the exported PDF in Preview and tell me how many pages it has."

For anything inside a web page, the agent uses your Chrome instead ([Browser](/documentation/browser)). Computer use covers what a web page can't reach: the address bar, a file picker, a permission prompt, or an app that isn't a website.

## What you see on your Mac

```figure
TwoCursorsFigure
Your pointer stays in the window you are using. The agent's orange pointer works in the window behind it.
```

- **The orange pointer.** Whenever the agent clicks or types somewhere, an orange pointer glides there and pulses on the press. It never takes your focus; it is there so you can see what the agent is doing.
- **Windows stay where they are.** The agent doesn't bring apps to the front. Typing and most clicks reach a window in the background.
- **It asks before taking your screen.** A few controls only respond to a real mouse click on a window in front. The agent first looks for another way (a keyboard shortcut, a menu item), and if there is none, it asks you before bringing the window forward.

## What you see in codecast

Each step the agent takes lands in the conversation above its reply, with a thumbnail of the window it read. Click a thumbnail to see it full size. The reply tells you what the agent did and what changed.

The agent also knows the difference between *it worked* and *I pressed the button*. When it can read the result back (a field now holds the text, a checkbox is now ticked) it says so. When an app gives no way to confirm, it looks at the window again before claiming success, and tells you if the app ignored it.

## What it will and won't do

```figure
ReadVsMarkFigure
Reading and checking are the agent's to do. Anything that leaves a mark waits until you ask for it.
```

- **Reading is free; leaving a mark is yours.** Agents read windows, find things and report back on their own. Sending a message, submitting a form, buying something, deleting data or changing a setting happens only when you asked for that.
- **Sensitive apps stay narrow.** In an app holding private content, the agent reads only what you asked it to read.

```figure
GuardrailsFigure
Two refusals that hold no matter what the agent is asked: password managers are off limits, and secret fields are hidden before the agent sees them.
```

- **Password managers are refused.** 1Password, Bitwarden, Dashlane, LastPass, NordPass and Proton Pass can't be read or driven at all. The helper refuses them itself, so no agent can talk its way around it.
- **Secret fields never show.** A password, passcode or one-time code field appears to the agent as `[redacted]`. The real value never reaches the agent or your conversation.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The card asks for permissions you already granted | Click **Open System Settings**, switch **codecast computer** off and on again in that list, then come back |
| The agent says it can't take pictures of windows | Turn on **Screen Recording** for **codecast computer**. Everything else keeps working meanwhile |
| The agent asks to bring a window forward | Say yes if you can spare the screen for a moment, or tell it to find another way |
| The agent can't find a window | Open the app, or the document, and ask again |

Computer use is built for macOS. On a Linux machine running a desktop, the same feature drives apps through Linux's accessibility layer.
