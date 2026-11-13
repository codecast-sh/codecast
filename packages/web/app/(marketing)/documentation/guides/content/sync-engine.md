Codecast keeps a copy of your workspace on your own device: sessions, conversations you've opened, tasks, plans, docs and projects. Every screen draws from that copy first, then the server keeps it current in the background. That one choice is why the app behaves the way it does:

- **It opens instantly.** The inbox, your board and the conversations you've read appear straight away from what's already on your device, instead of a loading skeleton while the server answers. You see a skeleton only the very first time a screen has nothing stored yet.
- **Your changes show the moment you make them.** Mark a task done, move a session, rename a plan: the screen updates as you click, and the save goes to the server behind it. A slower answer from the server can't flip your change back.
- **Nothing you do is lost to a bad connection.** Changes you make while the connection is down are kept on your device and sent when it returns, even if you reload or close the window in between.
- **Busy workspaces stay light.** Only what changed travels to you. A team with hundreds of agent sessions sending updates every second doesn't resend your whole inbox each time.

![The codecast inbox: sessions grouped by who acts next beside an open conversation](/documentation/shots/inbox.webp "The inbox and the open conversation draw from the copy on your device, and update in place as sessions change.")

## Several windows, one picture

In the Mac app you may have the main window, a few tabs pulled out into their own windows, and the command palette open at once. One window does the syncing and the others share what it receives, so every window shows the same thing at the same time. A change you make in one window appears in the others right away, without waiting for the server. Close the window that was syncing and another takes over on its own.

## The sync light

When everything on screen matches the server, the header shows nothing. A small light appears beside the header's other controls only when something is catching up, the connection is down, or Codecast on this computer needs a look. Hover it for detail.

| The light | Hover panel says | What it means |
|-----------|------------------|---------------|
| None | | Up to date. Everything on screen matches the server |
| Cyan, pulsing | **Syncing the latest data** | A screen is loading for the first time on this device |
| Amber | **Sync is slow** | Catching up has taken more than 20 seconds. Your changes are safe and will be sent |
| Amber | **Reconnecting** | The link to the server dropped. You're looking at your stored copy, and it syncs when the link returns |
| Amber | **Offline** | This device has no network. Everything you've opened before is still there to read, and changes wait until you're back online |
| Green | A problem with Codecast on this computer | Your data is in sync, but the Codecast app on this machine is stale, offline or quiet. The hover panel says which |

![The sync light's hover panel reading Syncing the latest data, with each part of the workspace and whether it has caught up](/documentation/sync-engine/sync-status.webp "Hover the light to see what is still catching up.")

Coming back after hours or days away, the app catches up on just what changed while you were gone. After a long absence it rebuilds the stored copy quietly in the background, adding what's missing without emptying what you already see.

## Who can see what

Your device only ever receives what you're allowed to read. A task kept private inside a team stays on its owner's devices, and when someone's access to something is removed, it disappears from their copy too.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The light stays amber | Hover it to see why, and check your connection. If it's fine, reload the window; nothing you changed is lost |
| One window shows something different from another | Reload the window that looks stale. Windows normally agree within a moment |
| Something still looks wrong right after codecast updated | Reload once so the window runs the newest version |
