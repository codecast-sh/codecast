# cast computer on Linux: what Wayland would take

Status: assessment, no code. Written for ct-94270 (plan pl-1034), 2026-11-14.

Today the Linux provider (`packages/cli/src/computer/linux/helper.py`) is X11 only: trees from AT-SPI, windows from EWMH properties, pointer and keyboard through XTEST, pixels through `XGetImage`, all on the Xvfb at `:99` that `src/browser/provisionLinux.ts` starts on every cloud host. This note covers what a Wayland session changes, what a headless cloud host would need to run one, and what that costs next to Xvfb.

## What stays the same

**The accessibility tree.** AT-SPI is a D-Bus protocol and does not care about the display server. GTK 3 and 4, Qt 5 and 6, Chromium and Electron publish the same trees under Wayland. The renderer, element signatures, the event monitor that drives settle and the skipped pre-action walk, and every action that goes through AT-SPI (`Action.do_action`, `EditableText`, `Value`, text selection) carry over unchanged. On the e2e page those cover most verbs: click by action, set-value, select-all, secondary actions.

**The protocol.** The helper's socket protocol and the CLI above it do not change.

## What changes

| Piece | X11 today | Wayland |
|---|---|---|
| Pointer and keyboard | XTEST, any window, no consent | libei through the RemoteDesktop portal (GNOME 46+, KDE Plasma 6), one consent per session; input reaches the focused surface only |
| Pixels | `XGetImage` on the root, any rectangle | ScreenCast portal, frames over PipeWire; monitor or window source picked at consent time |
| Window list, ids, geometry | `_NET_CLIENT_LIST_STACKING`, X window ids | no client can list or place other clients' windows; AT-SPI frames are the only portable list |
| Element frames | AT-SPI `SCREEN` extents minus the window origin | toolkits report coordinates relative to their own window (GTK 4, GTK 3 on Wayland); the window's screen origin is unknown to clients |
| Raise and focus (`--restore-window`) | `_NET_ACTIVE_WINDOW` | not available to clients; compositors refuse focus stealing |
| Unicode typing | temporary keycode bindings | libei sends keycodes against the compositor's keymap; characters outside it need the keymap the EIS device carries, or AT-SPI `insert_text` |

The consequences for the verbs:

- **Synthetic clicks need the window origin.** AT-SPI frames are window-relative, and a libei absolute pointer moves in compositor (screen) coordinates. Without the window's position, `click --mouse`, scroll and drag cannot aim. The ScreenCast window source gives the window's pixels but not its place on the screen. On GNOME, `org.gnome.Shell.Introspect.GetWindows` has geometry but is restricted to allowed callers. A per-compositor answer is needed here; it is the hardest gap.
- **Keyboard input is focus-bound.** Every synthetic key lands in the focused surface, so `type-text` into a background window works only through AT-SPI `insert_text` (GTK's `EditableText`). Chromium publishes no `EditableText`, so typing into a background Chrome field cannot work. Cua's driver documents the same limit (`background_unavailable` for keys sent to a field that is not AT-SPI editable).
- **Pixel diffs get costlier.** `pixelChange` reads the window three times around an action. A PipeWire stream gives a frame as the compositor produces it. Keeping a stream open for the window makes each read cheap but costs compositor and copy CPU for as long as it stays open. Opening a stream per read adds the stream negotiation (tens of ms) to every capture.

## The portal flow, and where it bites

The portal path from the portal_use write-up (GNOME 50):

1. `org.freedesktop.portal.RemoteDesktop.CreateSession`, then `SelectDevices` (keyboard, pointer) and `ScreenCast.SelectSources` on the same session, then `Start`. `Start` raises the consent dialog.
2. `ConnectToEIS` returns a socket for libei. Start emulating only after `EI_EVENT_DEVICE_RESUMED`; events sent after `DEVICE_ADDED` but before resume are dropped without an error.
3. Use two pointer devices: an absolute one aims the clicks, and on GNOME 50 a relative one is also needed to move the visible cursor.
4. Move the pointer off (0, 0) after connecting, or it opens GNOME's Activities hot corner.
5. `persist_mode` in the combined RemoteDesktop + ScreenCast `SelectSources` call hangs with no reply on GNOME 46 to 50. The workaround is to try with a timeout, then retry without persistence, so consent lasts one login session.

KDE Plasma 6 implements the same portals but is untested by either source. wlroots compositors (Sway, Hyprland) have partial EIS support that varies by build; they have their own protocols instead (`wlr-virtual-pointer`, `zwp_virtual_keyboard`, `wlr-screencopy`), which need no portal or consent.

## A headless cloud host

A cloud host has no person to click a consent dialog and no monitor, so the portal flow above cannot run there as written. Three ways around it, none of them tested yet:

1. **GNOME headless, Mutter's own APIs.** `gnome-shell --headless --virtual-monitor 1440x900` runs a full GNOME session with no GPU or display. `gnome-remote-desktop` drives a headless session without any dialog by calling Mutter's private D-Bus APIs directly: `org.gnome.Mutter.RemoteDesktop` (input, with `ConnectToEIS` since Mutter 46) and `org.gnome.Mutter.ScreenCast` (PipeWire streams). The helper could do the same. These are session-bus APIs with no consent step and no stability promise, so they can change between GNOME releases.
2. **Portal with a pre-seeded grant.** Grant once through a scripted session (or a VNC login, the way the Mac grants TCC), keep the `restore_token`, and reuse it. This is blocked on GNOME 46 to 50 by the `persist_mode` hang above, and the token is per app id, which a helper run by `python3` does not have.
3. **Sway headless.** `WLR_BACKENDS=headless sway` with the wlroots virtual input and screencopy protocols: no consent, small. Few people run Sway, so it tests the Wayland code paths without matching what users run.

### Cost next to Xvfb

| | Xvfb (today) | GNOME headless |
|---|---|---|
| Processes | `Xvfb` (~30 MB) | gnome-shell, mutter, xdg-desktop-portal and -gnome, pipewire, wireplumber, gnome-remote-desktop: several hundred MB before any app |
| Rendering | X server software paths | the compositor composites every frame with llvmpipe on the CPU |
| Input | XTEST, no consent, any window | EIS session to set up and keep alive; focus-bound |
| Pixels | one `XGetImage` per read | PipeWire stream per window, open or opened on demand |
| Window list and geometry | EWMH, complete | no portable source |
| Packages | Xvfb plus the AT-SPI and python-xlib packages | `gnome-shell`, `gnome-remote-desktop`, portals, pipewire stack |

On a 4 vCPU / 8 GB host such as the one this work was measured on, GNOME headless fits, but it is a session's worth of standing CPU and memory next to a 30 MB X server, and it adds a moving private API.

## Recommendation

Keep Xvfb as the cloud host display. Every app a cloud agent launches there is an X11 client, and the X11 path measures 170 to 270 ms per action, with no consent and no focus limits.

Wayland matters only on a person's own Linux desktop, where the session already exists and they can grant consent once per login. Build that path when a user needs it, in this order:

1. Run the AT-SPI-only verbs unchanged on Wayland: the tree, click and set-value by action, select-all.
2. Key and pointer input through the RemoteDesktop portal and libei, focus-bound, with clear errors for background targets.
3. Capture through ScreenCast and PipeWire.
4. Window geometry per compositor, the open problem.

Meanwhile, apps can run under XWayland (`GDK_BACKEND=x11`, `QT_QPA_PLATFORM=xcb`, Chrome's `--ozone-platform=x11`), and the existing X11 path should then work against them (untested: XTEST input under XWayland reaches only X clients).

Sources: [portal_use on GNOME 50](https://coderlegion.com/14454/i-built-a-wayland-native-ai-computer-use-server-because-nobody-else-did), [Cua on Linux and Wayland](https://cua.ai/docs/explanation/linux-and-wayland). The headless options come from Mutter's and gnome-remote-desktop's documented behavior and have not been tried on a host.
