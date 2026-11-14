#!/usr/bin/env python3
"""The codecast computer helper for Linux: X11 plus AT-SPI.

It answers the same newline JSON protocol as the macOS helper
(native/computer-use-macos), so the CLI's client, formatter, tree filters and
diffs work unchanged. Trees come from AT-SPI; windows, focus, pointer and keyboard
input and screenshots from the X server (python-xlib and XTEST), and the
clipboard from xclip.

The CLI embeds this file and writes it to ~/.codecast/computer/linux/. The
pure parts (the renderer, chords, PNG encoding) import nothing beyond the
standard library, so `--self-test` runs them on any machine.
"""

import base64
import contextlib
import warnings
import json
import os
import re
import select
import socket
import struct
import subprocess
import sys
import time
import uuid
import zlib

PROTOCOL_VERSION = 1
PROVIDER = "codecast-computer-linux"

MAX_NODES = 1200
MAX_DEPTH = 64
MAX_ROWS = 20
PREVIEW_LENGTH = 120
TAB_STRIP_MIN_TABS = 10
CACHE_MAX_ENTRIES = 32
CACHE_MAX_AGE = 120.0
UNCLAIMED_DEADLINE = 30.0
IDLE_DEADLINE = CACHE_MAX_AGE
PASTE_CAP = 16 * 1024 * 1024
MAX_CLICK_COUNT = 3
# How long a temporarily bound keycode stays bound after its last press, so
# the app has read the press before the binding goes.
TYPE_REBIND_PAUSE = 0.03
WHEEL_CLICKS_PER_PAGE = 5
ATSPI_TIMEOUT_MS = 2500
# How often the idle server dispatches queued AT-SPI events.
IDLE_PUMP_SECONDS = 0.25

REDACTED = "[redacted]"
SECRET_MARKERS = ("secure", "password", "passcode", "verification code", "one-time code")

# Password managers are refused under any name, like the macOS block list.
BLOCKED_APPS = {
    "1password", "bitwarden", "keepassxc", "org.keepassxc.keepassxc", "keepass2", "keepass",
    "proton pass", "proton-pass", "nordpass", "lastpass", "dashlane", "enpass",
}


class Phases:
    """Where one request's time goes, written to stderr per request when
    CODECAST_COMPUTER_TIMING is set (computer-linux-bench.py reads it)."""

    def __init__(self):
        self.enabled = bool(os.environ.get("CODECAST_COMPUTER_TIMING"))
        self.spent = {}

    def __call__(self, name):
        phases = self

        class Span:
            def __enter__(self):
                self.t0 = time.perf_counter()

            def __exit__(self, *_):
                phases.spent[name] = phases.spent.get(name, 0.0) + time.perf_counter() - self.t0
        return Span()

    def flush(self, method):
        if self.enabled and self.spent:
            sys.stderr.write("timing %s %s\n" % (method, json.dumps({k: round(v * 1000, 1) for k, v in self.spent.items()})))
            sys.stderr.flush()
        self.spent = {}


PHASES = Phases()


class ProviderError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ── pure helpers ──────────────────────────────────────────────────────────────


def sanitize(value):
    return value.replace("\n", " ").replace("\r", " ")


def clean(value):
    if value is None:
        return None
    text = sanitize(str(value)).replace("\ufffc", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def preview(value, limit=PREVIEW_LENGTH):
    text = sanitize(value)
    return text if len(text) <= limit else text[:limit] + "..."


def split_camel(value):
    out = ""
    for ch in value:
        if ch.isupper() and out and not out.endswith(" "):
            out += " "
        out += ch
    return out


def pretty_action(name):
    return split_camel(name.replace("_", " ").replace("-", " ")).lower().strip()


# Actions every element of a kind advertises: listing them tells the agent
# nothing. Click and press are what `click` performs on its own.
NOISY_ACTIONS = {"click", "press", "activate", "jump", "dodefault", "showcontextmenu", "show context menu", "menu",
                 "toggle", "check", "uncheck", "open", "select", "scroll backward", "scroll forward"}


def meaningful_actions(actions):
    seen = set()
    out = []
    keys = {pretty_action(a) for a in actions}
    vertical = "scroll up" in keys or "scroll down" in keys
    for action in actions:
        key = pretty_action(action)
        if not key or key in seen:
            continue
        seen.add(key)
        if action.lower() in NOISY_ACTIONS or key in NOISY_ACTIONS:
            continue
        # Like the macOS tree: a pane that scrolls vertically lists only that.
        if vertical and key in ("scroll left", "scroll right"):
            continue
        out.append(action)
    return out


# AT-SPI role -> (kind, role text). The role text follows the macOS helper's
# vocabulary so the same agent instructions read both trees.
ROLE_MAP = {
    "push button": ("button", "button"),
    "button": ("button", "button"),
    "toggle button": ("check", "toggle button"),
    "check box": ("check", "check box"),
    "switch": ("check", "switch"),
    "radio button": ("check", "radio button"),
    "check menu item": ("menuitem", "menu item"),
    "radio menu item": ("menuitem", "menu item"),
    "menu item": ("menuitem", "menu item"),
    "menu": ("menu", "menu"),
    "menu bar": ("menubar", "menu bar"),
    "popup menu": ("menu", "menu"),
    "entry": ("field", "text field"),
    "password text": ("field", "secure text field"),
    "spin button": ("field", "stepper"),
    "text": ("textarea", "text entry area"),
    "editbar": ("field", "text field"),
    "combo box": ("combo", "combo box"),
    "label": ("static", "text"),
    "static": ("static", "text"),
    "caption": ("static", "text"),
    "heading": ("heading", "heading"),
    "link": ("link", "link"),
    "image": ("image", "image"),
    "icon": ("image", "image"),
    "canvas": ("image", "canvas"),
    "list": ("rows", "list"),
    "list box": ("rows", "list"),
    "table": ("rows", "table"),
    "tree": ("rows", "outline"),
    "tree table": ("rows", "outline"),
    "list item": ("row", "row"),
    "table row": ("row", "row"),
    "tree item": ("row", "row"),
    "table cell": ("cell", "cell"),
    "column header": ("cell", "column header"),
    "row header": ("cell", "row header"),
    "table column header": ("cell", "column header"),
    "table row header": ("cell", "row header"),
    "animation": ("image", "animation"),
    "page tab": ("tab", "tab"),
    "page tab list": ("tablist", "tab group"),
    "scroll bar": ("scrollbar", "scroll bar"),
    "scroll pane": ("scrollarea", "scroll area"),
    "slider": ("value", "slider"),
    "progress bar": ("value", "progress indicator"),
    "level bar": ("value", "level indicator"),
    "tool bar": ("toolbar", "toolbar"),
    "status bar": ("container", "status bar"),
    "document web": ("web", "html content"),
    "document frame": ("web", "html content"),
    "document text": ("web", "document"),
    "document email": ("web", "document"),
    "frame": ("window", "standard window"),
    "window": ("window", "window"),
    "dialog": ("window", "dialog"),
    "alert": ("window", "alert"),
    "file chooser": ("window", "dialog"),
    "tool tip": ("container", "tooltip"),
    "notification": ("container", "notification"),
    "separator": ("separator", "separator"),
}

CONTAINER_ROLES = {
    "panel", "filler", "section", "grouping", "unknown", "redundant object", "invalid", "form", "landmark",
    "article", "block quote", "description list", "description term", "description value", "internal frame",
    "layered pane", "root pane", "viewport", "split pane", "glass pane", "option pane", "paragraph", "embedded",
    "html container", "static", "footer", "header", "footnote", "comment", "mark", "suggestion", "content deletion",
    "content insertion", "log", "marquee", "timer", "application", "desktop frame", "directory pane",
    "color chooser", "font chooser", "page", "ruler", "autocomplete", "subscript", "superscript", "math",
    "definition", "info bar", "audio", "video", "rating", "push button menu", "image map", "list box",
}


def role_info(role):
    if role in ROLE_MAP:
        return ROLE_MAP[role]
    if role in CONTAINER_ROLES:
        return ("container", "container")
    return ("other", role or "unknown")


COMPACT_KINDS = {"button", "check", "combo", "heading", "menuitem", "static", "tab"}
TEXT_VALUE_ROLE_TEXTS = {"text", "text entry area", "text field", "secure text field", "scroll bar"}


class Node:
    """What the renderer needs about one element, read once.

    A label or static that holds other elements (Chromium's `<label>Name
    <input></label>`) is a container, or its field would be hidden under it."""

    __slots__ = ("role", "kind", "role_text", "name", "description", "value", "placeholder", "url",
                 "traits", "actions", "text", "child_count")

    def __init__(self, role, name=None, description=None, value=None, placeholder=None, url=None,
                 traits=None, actions=None, text=None, child_count=0):
        self.role = role
        self.kind, self.role_text = role_info(role)
        if self.kind == "static" and text is not None and "\ufffc" in text:
            self.kind, self.role_text = "container", "container"
        self.name = name
        self.description = description
        self.value = value
        self.placeholder = placeholder
        self.url = url
        self.traits = traits or []
        self.actions = actions or []
        self.text = text
        self.child_count = child_count


def display_name(node):
    name = clean(node.name)
    if node.kind == "link":
        text = name or clean(node.text)
        url = clean(node.url)
        if url and text:
            return "[%s](%s)" % (text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]"), url)
        return text
    return name


def text_summary(node):
    """Text a node carries in its own Text interface, when nothing else names it.

    A child that is not plain text (a link, a field, an image) appears in its
    parent's text as U+FFFC. Text without one is the whole subtree, so the
    node reads as one line and its text children are not repeated under it.
    """
    if node.kind in ("field", "textarea", "combo", "link", "window", "web"):
        return None
    if display_name(node) is not None or not node.text or "\ufffc" in node.text:
        return None
    return clean(node.text)


def should_elide(node):
    if node.kind == "separator":
        return True
    if node.kind != "container":
        return False
    return (display_name(node) is None and not node.traits and not meaningful_actions(node.actions)
            and text_summary(node) is None and clean(node.description) is None)


def should_suppress_children(node, summary):
    if node.kind == "scrollbar" or summary is not None:
        return True
    name = display_name(node)
    if node.kind == "link" and name and name.startswith("["):
        return True
    compact = name is not None or clean(node.value) is not None or summary is not None
    return compact and node.kind in COMPACT_KINDS


def render_line(index, node):
    name = display_name(node)
    summary = text_summary(node)
    role_text = node.role_text
    if summary is not None and node.kind in ("container", "static", "other", "row", "cell"):
        # A block of text with no other identity reads as text, like a macOS static text.
        if node.kind in ("container", "static", "other"):
            role_text = "text"
    line = "%d %s" % (index, role_text) if role_text else str(index)
    if node.traits:
        line += " (%s)" % ", ".join(node.traits)
    if name:
        line += " " + sanitize(name)
    desc = clean(node.description)
    if desc and desc != name:
        line += ", Description: " + sanitize(desc)
    value = clean(node.value)
    if value is not None and value != name:
        value = preview(value)
        line += (" " + value) if role_text in TEXT_VALUE_ROLE_TEXTS else ", Value: " + value
    placeholder = clean(node.placeholder)
    if placeholder and placeholder != name and placeholder != value:
        line += (" Placeholder: " if name is None and value is None else ", Placeholder: ") + sanitize(placeholder)
    if summary is not None:
        if role_text == "text" and not name and value is None:
            line += " " + preview(summary)
        else:
            line += ", Text: " + preview(summary)
    actions = meaningful_actions(node.actions)
    if actions:
        line += ", Secondary Actions: " + ", ".join(pretty_action(a) for a in actions)
    return line


def signature(node):
    return "\x1f".join([node.role, node.name or "", node.description or "", node.url or "",
                        ",".join(meaningful_actions(node.actions))])


def is_secure(role, name=None, description=None, placeholder=None):
    if role == "password text":
        return True
    kind = role_info(role)[0]
    if kind not in ("field", "textarea", "combo"):
        return False
    hay = " ".join(x for x in (role, name or "", description or "", placeholder or "")).lower()
    return any(marker in hay for marker in SECRET_MARKERS)


def tree_envelope(app_id, pid, title, app_name, lines, focused_line):
    out = [
        "App=%s (pid %d)" % (app_id, pid),
        'Window: "%s", App: %s.' % (sanitize(title), sanitize(app_name)),
        "",
    ]
    out.extend(lines)
    out.append("")
    out.append("The focused UI element is %s." % focused_line if focused_line else "No UI element is currently focused.")
    return "\n".join(out)


def blocked_note(dialog_title, window_id):
    return ('Blocked: the dialog "%s" is modal, and this window does not respond until it closes. '
            "Target it with --window-id %d." % (sanitize(dialog_title), window_id))


def window_match_score(ext, name, win):
    """How well an AT-SPI window (its screen extents and name) matches an X
    window: their overlap over their union, plus one for a matching title. A
    parent window under its centered dialog covers all of the dialog, so a
    share of the X window alone ties the two."""
    ix = max(0, min(ext[0] + ext[2], win["x"] + win["width"]) - max(ext[0], win["x"]))
    iy = max(0, min(ext[1] + ext[3], win["y"] + win["height"]) - max(ext[1], win["y"]))
    inter = ix * iy
    union = max(0, ext[2]) * max(0, ext[3]) + win["width"] * win["height"] - inter
    score = inter / max(1, union)
    title = win["title"]
    if name and title and (name == title or title.startswith(name) or name.startswith(title)):
        score += 1.0
    return score


# How long after the second capture the third one is taken: long enough for a
# spinner or a clock to move, short enough to add little to the action.
REPAINT_PROBE_SECONDS = 0.15


def changed_rect(a, b):
    """Where two raw captures of one window differ, as {x, y, width, height} in
    window pixels, or None. Each capture is (width, height, bytes) at 4 bytes a
    pixel. The same content captures to the same bytes, so the compare is
    exact; a resized window differs everywhere."""
    (aw, ah, ad), (bw, bh, bd) = a, b
    if (aw, ah) != (bw, bh) or len(ad) != len(bd):
        return {"x": 0, "y": 0, "width": max(aw, bw), "height": max(ah, bh)}
    if ad == bd:
        return None
    row = len(ad) // max(1, ah)
    min_x = min_y = None
    max_x = max_y = -1
    for y in range(ah):
        ra, rb = ad[y * row:(y + 1) * row], bd[y * row:(y + 1) * row]
        if ra == rb:
            continue
        first, last = _first_diff(ra, rb), len(ra) - 1 - _first_diff(ra[::-1], rb[::-1])
        min_x = first // 4 if min_x is None else min(min_x, first // 4)
        max_x = max(max_x, min(last // 4, aw - 1))
        min_y = y if min_y is None else min_y
        max_y = y
    if min_y is None:
        return None
    return {"x": min_x, "y": min_y, "width": max_x - min_x + 1, "height": max_y - min_y + 1}


def _first_diff(a, b):
    """The first index where two equal-length, different byte strings differ."""
    lo, hi = 0, len(a)
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if a[:mid] == b[:mid]:
            lo = mid
        else:
            hi = mid
    return lo


# How long an action waits before the snapshot it returns, like the macOS
# helper's ActionSettle.swift. The app says when it has reacted: each change to
# its tree posts an AT-SPI event, and the helper counts them per application.
# The wait ends a short quiet spell after the last one, which is sooner than
# any fixed sleep for a checkbox and later than one for a dialog still arriving.
# An app that posts nothing gets the reaction window and no more: synthetic
# input is only queued, and the app handles it on its next main loop turn.
SETTLE_QUIET = 0.06
SETTLE_CEILING = 0.8
SETTLE_POLL = 0.005


def reaction_window(path):
    return 0.25 if path in ("synthetic", "clipboard") else 0.12


class ActionSettle:
    """`count_before` is read before the action runs; `count` is None when the
    app cannot be observed."""

    def __init__(self, path, count_before, now):
        self.reaction = reaction_window(path)
        self.started = now
        self.last_count = count_before
        self.last_change = None

    def is_settled(self, count, now):
        elapsed = now - self.started
        if count is None or self.last_count is None:
            return elapsed >= self.reaction
        if count != self.last_count:
            self.last_count = count
            self.last_change = now
        if elapsed >= SETTLE_CEILING:
            return True
        if self.last_change is None:
            return elapsed >= self.reaction
        return now - self.last_change >= SETTLE_QUIET


MODIFIERS = {
    "cmd": "ctrl", "command": "ctrl", "cmdorctrl": "ctrl", "commandorcontrol": "ctrl",
    "ctrl": "ctrl", "control": "ctrl", "alt": "alt", "option": "alt", "shift": "shift",
    "meta": "super", "super": "super", "win": "super",
}

KEYS = {
    "return": "Return", "enter": "Return", "tab": "Tab", "space": "space", "escape": "Escape", "esc": "Escape",
    "backspace": "BackSpace", "delete": "BackSpace", "forwarddelete": "Delete", "del": "Delete",
    "left": "Left", "right": "Right", "up": "Up", "down": "Down", "home": "Home", "end": "End",
    "pageup": "Prior", "page_up": "Prior", "pagedown": "Next", "page_down": "Next", "insert": "Insert",
    "+": "plus", "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", ";": "semicolon",
    "'": "apostrophe", "[": "bracketleft", "]": "bracketright", "\\": "backslash", "`": "grave",
    "menu": "Menu", "capslock": "Caps_Lock",
}


def split_chord(spec):
    parts, current = [], ""
    for ch in spec:
        if ch != "+":
            current += ch
            continue
        if current == "":
            parts.append("+")
        else:
            parts.append(current)
            current = ""
    if current:
        parts.append(current)
    return [p.strip() for p in parts if p.strip() or p == "+"]


def keysym(name):
    lower = name.lower()
    if lower in KEYS:
        return KEYS[lower]
    if re.fullmatch(r"f([1-9]|1[0-9]|2[0-4])", lower):
        return lower.upper()
    if len(name) == 1 and name.isalnum():
        return name.lower()
    raise ProviderError("invalid_argument", "unsupported key '%s'" % name)


# The key that holds each modifier down.
MODIFIER_KEYSYMS = {"ctrl": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "super": "Super_L"}


def chord_keysyms(spec):
    """A chord as the keysym names to press in order: modifiers, then the key."""
    mods, keys = [], []
    for part in split_chord(spec):
        mod = MODIFIERS.get(part.lower())
        if mod:
            if mod not in mods:
                mods.append(mod)
        else:
            keys.append(keysym(part))
    if len(keys) != 1:
        raise ProviderError("invalid_argument", "a chord needs exactly one non-modifier key: '%s'" % spec)
    return [MODIFIER_KEYSYMS[m] for m in mods] + keys


def char_keysym(ch):
    """The X keysym that types one character: Latin-1 keysyms are the code
    point itself, every other character is 0x01000000 plus its code point."""
    if ch == "\n" or ch == "\r":
        return 0xFF0D  # Return
    if ch == "\t":
        return 0xFF09  # Tab
    code = ord(ch)
    if 0x20 <= code <= 0x7E or 0xA0 <= code <= 0xFF:
        return code
    return 0x01000000 | code


def parse_modifiers(spec):
    if not spec:
        return []
    mods = []
    for part in spec.split("+"):
        mod = MODIFIERS.get(part.strip().lower())
        if not mod:
            raise ProviderError("invalid_argument", "unsupported click modifier '%s'" % part)
        mods.append(mod)
    return mods


def is_select_all(spec):
    parts = [p.lower() for p in split_chord(spec)]
    return bool(parts) and parts[-1] == "a" and any(MODIFIERS.get(p) == "ctrl" for p in parts[:-1]) and len(parts) == 2


def encode_png(width, height, rgb):
    """A plain RGB PNG from packed rows, standard library only."""
    stride = width * 3
    raw = b"".join(b"\x00" + rgb[y * stride:(y + 1) * stride] for y in range(height))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def bgrx_to_rgb(data, width, height):
    pixels = width * height
    rgb = bytearray(pixels * 3)
    rgb[0::3] = data[2:pixels * 4:4]
    rgb[1::3] = data[1:pixels * 4:4]
    rgb[2::3] = data[0:pixels * 4:4]
    return bytes(rgb)


# ── environment ───────────────────────────────────────────────────────────────


def prepare_environment():
    """Find the display and the session bus from a bare environment.

    The daemon that launches this has neither DISPLAY nor a session bus
    address, and a cloud host's only display is the Xvfb at :99.
    """
    if not os.environ.get("DISPLAY"):
        for display, sock in ((":99", "/tmp/.X11-unix/X99"), (":0", "/tmp/.X11-unix/X0")):
            if os.path.exists(sock):
                os.environ["DISPLAY"] = display
                break
    runtime = os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
    if os.path.isdir(runtime):
        os.environ.setdefault("XDG_RUNTIME_DIR", runtime)
        bus = os.path.join(runtime, "bus")
        if not os.environ.get("DBUS_SESSION_BUS_ADDRESS") and os.path.exists(bus):
            os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + bus


def resolve_a11y_bus():
    """The accessibility bus address, with accessibility switched on for apps."""
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        raise ProviderError(
            "accessibility_error",
            "no D-Bus session bus for this user, so there is no accessibility bus. Enable lingering "
            "(`sudo loginctl enable-linger %s`) so the user bus outlives SSH logins, then retry." % os.environ.get("USER", "$USER"),
        )
    try:
        conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        reply = conn.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None,
                               GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NONE, 5000, None)
        address = reply.unpack()[0]
        try:
            conn.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
                           GLib.Variant("(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))),
                           None, Gio.DBusCallFlags.NONE, 5000, None)
        except Exception:
            pass
        return address
    except Exception as err:
        raise ProviderError(
            "accessibility_error",
            "the accessibility bus is not reachable (%s). Install at-spi2-core and retry." % str(err).splitlines()[0],
        )


# ── X11 ───────────────────────────────────────────────────────────────────────


class XServer:
    def __init__(self):
        from Xlib import X, Xatom, display
        from Xlib.ext import xtest
        self.X = X
        self.Xatom = Xatom
        self.xtest = xtest
        try:
            self.d = display.Display()
        except Exception as err:
            raise ProviderError("accessibility_error", "cannot open X display %s: %s" % (os.environ.get("DISPLAY"), err))
        self.screen = self.d.screen()
        self.root = self.screen.root
        self.atoms = {}

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = self.d.intern_atom(name)
        return self.atoms[name]

    def prop(self, win, name, kind=None):
        try:
            p = win.get_full_property(self.atom(name), kind if kind is not None else self.X.AnyPropertyType)
            return p.value if p else None
        except Exception:
            return None

    def publish_a11y_bus(self, address):
        """GTK and Qt find the accessibility bus on the root window, so apps
        started with nothing but DISPLAY join it."""
        current = self.prop(self.root, "AT_SPI_BUS")
        if isinstance(current, bytes):
            current = current.decode("utf-8", "replace")
        if current != address:
            self.root.change_property(self.atom("AT_SPI_BUS"), self.Xatom.STRING, 8, address.encode())
            self.d.sync()
            return True
        return False

    def wm_present(self):
        return self.prop(self.root, "_NET_SUPPORTING_WM_CHECK") is not None

    def title(self, win):
        name = self.prop(win, "_NET_WM_NAME", self.atom("UTF8_STRING"))
        if name is None:
            name = self.prop(win, "WM_NAME")
        if isinstance(name, bytes):
            return name.decode("utf-8", "replace")
        return name or ""

    def pid(self, win):
        value = self.prop(win, "_NET_WM_PID", self.Xatom.CARDINAL)
        return int(value[0]) if value is not None and len(value) else None

    def wm_class(self, win):
        """(instance, class). Chromium appends its profile to the instance,
        `google-chrome (/tmp/profile)`, which is no use as an app id."""
        try:
            cls = win.get_wm_class()
        except Exception:
            cls = None
        if not cls:
            return (None, None)
        return (re.sub(r"\s*\(.*\)$", "", cls[0] or "") or None, cls[1])

    def geometry(self, win):
        g = win.get_geometry()
        origin = win.translate_coords(self.root, 0, 0)
        return (-origin.x, -origin.y, g.width, g.height)

    def toplevels(self):
        """Client windows, top of the stack first."""
        stacking = self.prop(self.root, "_NET_CLIENT_LIST_STACKING") or self.prop(self.root, "_NET_CLIENT_LIST")
        wins = []
        if stacking is not None:
            wins = [self.d.create_resource_object("window", int(w)) for w in reversed(list(stacking))]
        else:
            for child in reversed(self.root.query_tree().children):
                try:
                    attrs = child.get_attributes()
                except Exception:
                    continue
                if attrs.override_redirect or attrs.map_state != self.X.IsViewable:
                    continue
                wins.append(child)
        out = []
        for win in wins:
            try:
                attrs = win.get_attributes()
                if attrs.map_state != self.X.IsViewable:
                    continue
                x, y, w, h = self.geometry(win)
            except Exception:
                continue
            if w <= 1 or h <= 1:
                continue
            out.append({"win": win, "id": win.id, "x": x, "y": y, "width": w, "height": h,
                        "pid": self.pid(win), "title": self.title(win), "class": self.wm_class(win)})
        return out

    def top_child(self, win):
        """The root child that holds `win` (its frame, under a reparenting WM).
        None for the root itself: X answers its parent as the integer 0."""
        current = win
        if isinstance(current, int) or current is None or current.id == self.root.id:
            return None
        for _ in range(16):
            try:
                tree = current.query_tree()
            except Exception:
                return None
            parent = tree.parent
            if parent is None or isinstance(parent, int) or parent.id in (0, self.root.id):
                return current.id
            current = parent
        return None

    def window_at(self, x, y):
        try:
            reply = self.root.translate_coords(self.root, x, y)
            child = reply.child
            return child.id if child else None
        except Exception:
            return None

    def focused_top(self):
        focus = self.d.get_input_focus().focus
        if isinstance(focus, int) or focus is None:
            return None
        return self.top_child(focus)

    def activate(self, win):
        """The only raise: `--restore-window`."""
        from Xlib.protocol import event
        if self.wm_present():
            data = [2, self.X.CurrentTime, 0, 0, 0]
            ev = event.ClientMessage(window=win, client_type=self.atom("_NET_ACTIVE_WINDOW"), data=(32, data))
            self.root.send_event(ev, event_mask=self.X.SubstructureRedirectMask | self.X.SubstructureNotifyMask)
        else:
            win.configure(stack_mode=self.X.Above)
            win.set_input_focus(self.X.RevertToParent, self.X.CurrentTime)
        self.d.sync()
        time.sleep(0.15)

    def move(self, x, y):
        self.xtest.fake_input(self.d, self.X.MotionNotify, x=int(round(x)), y=int(round(y)))
        self.d.sync()

    def button(self, number, down):
        self.xtest.fake_input(self.d, self.X.ButtonPress if down else self.X.ButtonRelease, number)
        self.d.sync()

    # ── keyboard, all through XTEST ──

    def named_keysym(self, name):
        from Xlib import XK
        sym = XK.string_to_keysym(name)
        if not sym:
            raise ProviderError("invalid_argument", "no keysym for %s" % name)
        return sym

    def fake_key(self, code, down):
        self.xtest.fake_input(self.d, self.X.KeyPress if down else self.X.KeyRelease, code)

    def key(self, keysym_name, down):
        """One modifier or key held or let go, by keysym name."""
        code = self.d.keysym_to_keycode(self.named_keysym(keysym_name))
        if not code:
            raise ProviderError("invalid_argument", "no keycode for %s" % keysym_name)
        self.fake_key(code, down)
        self.d.sync()

    def unused_keycodes(self):
        """(keysyms per keycode, keycodes with no keysym), read fresh: the
        unused keycodes are where a character the layout lacks is bound."""
        first = self.d.display.info.min_keycode
        rows = self.d.get_keyboard_mapping(first, self.d.display.info.max_keycode - first + 1)
        return (len(rows[0]) if rows else 2), [first + i for i, row in enumerate(rows) if not any(row)]

    def code_for(self, sym):
        """(keycode, needs shift) for a keysym on the layout, or None. Levels
        past shift need AltGr or a group switch, so those are bound instead."""
        best = None
        for code, index in self.d.keysym_to_keycodes(sym):
            if index == 0:
                return code, False
            if index == 1 and best is None:
                best = (code, True)
        return best

    @contextlib.contextmanager
    def clear_modifiers(self):
        """Typed text and chords mean exactly what they say: modifiers held
        and Caps Lock are let go for the input and restored after it."""
        keys = self.d.query_keymap()
        held = [code for codes in self.d.get_modifier_mapping() for code in codes
                if code and keys[code // 8] & (1 << (code % 8))]
        locked = bool(self.root.query_pointer().mask & self.X.LockMask)
        caps = self.d.keysym_to_keycode(self.named_keysym("Caps_Lock")) if locked else None
        for code in held:
            self.fake_key(code, False)
        if caps:
            self.fake_key(caps, True)
            self.fake_key(caps, False)
        try:
            yield
        finally:
            if caps:
                self.fake_key(caps, True)
                self.fake_key(caps, False)
            for code in held:
                self.fake_key(code, True)
            self.d.sync()

    def chord(self, names):
        """Press keysym names in order and let them go in reverse."""
        codes = []
        for name in names:
            code = self.d.keysym_to_keycode(self.named_keysym(name))
            if not code:
                raise ProviderError("invalid_argument", "no keycode for %s on this keyboard layout" % name)
            codes.append(code)
        with self.clear_modifiers():
            for code in codes:
                self.fake_key(code, True)
            for code in reversed(codes):
                self.fake_key(code, False)

    def type_text(self, text):
        """Type characters as key presses. A character the layout lacks is
        bound for the duration to an unused keycode, the way xdotool does,
        and every binding is undone at the end. X delivers a client's events
        in order, so a press always reads the mapping that was current when
        it was sent."""
        shift = self.d.keysym_to_keycode(self.named_keysym("Shift_L"))
        bound = {}
        touched = set()
        per, spare = None, None
        try:
            with self.clear_modifiers():
                for ch in text:
                    sym = char_keysym(ch)
                    if sym in bound:
                        hit = (bound[sym], False)
                    else:
                        hit = self.code_for(sym)
                    if hit is None:
                        if spare is None:
                            per, spare = self.unused_keycodes()
                        if not spare:
                            # Every unused keycode holds a character typed
                            # earlier: wait for those presses, then reuse.
                            self.d.sync()
                            time.sleep(TYPE_REBIND_PAUSE)
                            spare = list(bound.values())
                            bound.clear()
                        if not spare:
                            raise ProviderError("unsupported_capability", "the keyboard map has no unused keycode to type '%s' with" % ch)
                        code = spare.pop(0)
                        self.d.change_keyboard_mapping(code, [(sym,) * per])
                        bound[sym] = code
                        touched.add(code)
                        hit = (code, False)
                    code, needs_shift = hit
                    if needs_shift:
                        self.fake_key(shift, True)
                    self.fake_key(code, True)
                    self.fake_key(code, False)
                    if needs_shift:
                        self.fake_key(shift, False)
                    self.d.flush()
        finally:
            if touched:
                # The app reads a press with the mapping current when it reads
                # it: let the last presses land before the keycodes go blank.
                self.d.sync()
                time.sleep(TYPE_REBIND_PAUSE)
                for code in sorted(touched):
                    self.d.change_keyboard_mapping(code, [(0,) * per])
            self.d.sync()

    def raw(self, x, y, w, h):
        """The screen's BGRX bytes inside a rectangle, clipped to the screen."""
        sw, sh = self.screen.width_in_pixels, self.screen.height_in_pixels
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(sw, x + w), min(sh, y + h)
        if x1 <= x0 or y1 <= y0:
            return None
        width, height = x1 - x0, y1 - y0
        return width, height, bytes(self.root.get_image(x0, y0, width, height, self.X.ZPixmap, 0xFFFFFFFF).data)

    def capture(self, x, y, w, h):
        raw = self.raw(x, y, w, h)
        if raw is None:
            return None
        width, height, data = raw
        return width, height, encode_png(width, height, bgrx_to_rgb(data, width, height))

    def window_pixels(self, win):
        try:
            return self.raw(win["x"], win["y"], win["width"], win["height"])
        except Exception:
            return None


# ── AT-SPI ────────────────────────────────────────────────────────────────────


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def seconds_since_boot():
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except Exception:
        return None


def process_start(pid):
    """When a process started, in seconds since boot, or None."""
    try:
        with open("/proc/%d/stat" % pid) as f:
            fields = f.read().rsplit(")", 1)[1].split()
        return int(fields[19]) / os.sysconf("SC_CLK_TCK")
    except Exception:
        return None


def exe_name(pid):
    try:
        return os.path.basename(os.readlink("/proc/%d/exe" % pid))
    except Exception:
        try:
            with open("/proc/%d/comm" % pid) as f:
                return f.read().strip()
        except Exception:
            return None


# What an app says when its tree changes. Each one bumps that app's count; an
# equal count means nothing an index or a frame depends on has moved.
EVENT_TYPES = ("object:children-changed", "object:state-changed", "object:property-change",
               "object:text-changed", "object:text-caret-moved", "object:text-selection-changed",
               "object:selection-changed", "object:active-descendant-changed", "object:value-changed",
               "window:create", "window:destroy")
# Events dispatched per pump at most, so an app flooding the bus cannot hold
# the helper inside one.
PUMP_LIMIT = 20000


def bus_name(acc):
    """The D-Bus name of the app an accessible lives in, read from the proxy
    without a round trip (the pid costs one per call)."""
    try:
        return acc.app.bus_name if acc is not None and acc.app is not None else None
    except Exception:
        return None


def app_round_trip(acc):
    """One call the app answers itself (libatspi never caches attributes), so
    it waits for the app's main loop to be free."""
    try:
        acc.get_attributes()
        return True
    except Exception:
        return False


class EventMonitor:
    """Counts AT-SPI events per application.

    libatspi delivers events only while the GLib main context runs, so every
    read of a count first dispatches what has queued; the server loop pumps
    between requests too, so the bus never backs up while the helper idles.
    An event whose sender cannot be named counts for every app, which can only
    cost an extra walk."""

    def __init__(self, Atspi):
        from gi.repository import GLib
        self.ctx = GLib.MainContext.default()
        self.counts = {}
        self.unattributed = 0
        self.listener = Atspi.EventListener.new(self._on_event)
        self.ok = True
        for kind in EVENT_TYPES:
            try:
                if not self.listener.register(kind):
                    self.ok = False
            except Exception:
                self.ok = False

    def _on_event(self, event):
        bus = None
        try:
            bus = bus_name(event.source)
        except Exception:
            pass
        if bus:
            self.counts[bus] = self.counts.get(bus, 0) + 1
        else:
            self.unattributed += 1

    def pump(self):
        for _ in range(PUMP_LIMIT):
            if not self.ctx.iteration(False):
                break

    def count(self, app):
        """The app's event count so far, or None when it cannot be observed."""
        if not self.ok or app is None:
            return None
        bus = bus_name(app.accessible)
        if not bus:
            return None
        self.pump()
        return self.counts.get(bus, 0) + self.unattributed


CHROMIUM_HINTS = ("chrome", "chromium", "electron", "code", "slack", "discord", "brave", "msedge", "vivaldi", "opera", "obsidian", "notion", "signal", "teams", "spotify", "cursor")


class App:
    def __init__(self, name, pid, bundle_id, accessible, exe):
        self.name = name
        self.pid = pid
        self.bundle_id = bundle_id
        self.accessible = accessible
        self.exe = exe

    def info(self):
        return {"name": self.name, "bundleId": self.bundle_id, "pid": self.pid}

    def chromium_like(self):
        hay = " ".join(x.lower() for x in (self.exe or "", self.bundle_id or "", self.name or ""))
        return any(h in hay for h in CHROMIUM_HINTS)




class Record:
    __slots__ = ("index", "acc", "frame", "actions", "signature", "node", "ifaces")

    def __init__(self, index, acc, frame, actions, sig, node, ifaces):
        self.index = index
        self.acc = acc
        self.frame = frame
        self.actions = actions
        self.signature = sig
        self.node = node
        self.ifaces = ifaces


class Snapshot:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class Provider:
    def __init__(self, version):
        self.version = version
        self.snapshots = {}
        self.entries = []
        self.pre_action_tree = None
        self.pre_pixels = None
        self.settle_mark = None
        # When this helper announced the bus on the display itself (seconds
        # since boot): apps started there before then are not on it.
        self.announced_bus = None
        self._x = None
        self._atspi = None
        self.events = None

    # lazily, so `handshake` answers even on a box missing a dependency
    @property
    def x(self):
        if self._x is None:
            try:
                self._x = XServer()
            except ImportError:
                raise ProviderError("unsupported_capability", "python3-xlib is not installed (apt install python3-xlib)")
        return self._x

    @property
    def atspi(self):
        if self._atspi is None:
            address = resolve_a11y_bus()
            os.environ["AT_SPI_BUS_ADDRESS"] = address
            try:
                if self.x.publish_a11y_bus(address):
                    self.announced_bus = seconds_since_boot()
            except ProviderError:
                pass
            try:
                import gi
                gi.require_version("Atspi", "2.0")
                from gi.repository import Atspi
            except (ImportError, ValueError):
                raise ProviderError("unsupported_capability", "the AT-SPI bindings are missing (apt install gir1.2-atspi-2.0 python3-gi)")
            # get_action_name is marked deprecated in favour of a GObject
            # accessor that returns the same string.
            warnings.filterwarnings("ignore", category=DeprecationWarning)
            Atspi.init()
            try:
                Atspi.set_timeout(ATSPI_TIMEOUT_MS, ATSPI_TIMEOUT_MS * 2)
            except Exception:
                pass
            self._atspi = Atspi
            try:
                self.events = EventMonitor(Atspi)
            except Exception:
                self.events = None
        return self._atspi

    def event_count(self, app):
        return self.events.count(app) if self.events is not None else None

    def idle_pump(self):
        """Between requests: dispatch queued events so the bus never backs up."""
        if self.events is not None:
            self.events.pump()

    def capabilities(self):
        return {
            "platform": "linux",
            "provider": PROVIDER,
            "providerVersion": self.version,
            "protocolVersion": PROTOCOL_VERSION,
            "supports": {
                "apps": {"list": True, "bundleIds": True, "pids": True},
                "windows": {"list": True, "targetById": True, "targetByIndex": True, "focus": False, "moveResize": False},
                "observation": {"screenshot": True, "annotatedScreenshot": False, "elementFrames": True, "ocr": False},
                "actions": {"click": True, "typeText": True, "pressKey": True, "hotkey": True, "pasteText": True,
                            "scroll": True, "drag": True, "setValue": True, "performAction": True},
                "surfaces": {"menus": False, "dialogs": False, "dock": False, "menubar": False},
            },
        }

    def handle(self, method, params):
        if method == "handshake":
            return self.capabilities()
        if method == "listApps":
            return {"apps": [dict(a.info(), isRunning=True, lastUsedAt=None, useCount=None) for a in self.list_apps()]}
        if method == "listWindows":
            return self.list_windows(params)
        if method == "getAppState":
            previous = None
            if params.get("diff") is True:
                cached = self.cached(params)
                previous = cached.tree if cached else None
            result = self.render(self.observe(params))
            if previous is not None:
                result["baselineTreeText"] = previous
            return result
        actions = {
            "click": self.click, "performSecondaryAction": self.secondary, "setValue": self.set_value,
            "typeText": self.type_text, "pressKey": self.press_key, "hotkey": self.hotkey,
            "pasteText": self.paste_text, "scroll": self.scroll, "drag": self.drag,
        }
        if method in actions:
            return self.action_result(params, actions[method])
        raise ProviderError("invalid_argument", "unknown method '%s'" % method)

    # ── apps and windows ─────────────────────────────────────────────────────

    def list_apps(self):
        Atspi = self.atspi
        wins = self.x.toplevels()
        class_by_pid = {}
        for w in wins:
            if w["pid"] and w["pid"] not in class_by_pid and w["class"][0]:
                class_by_pid[w["pid"]] = w["class"]
        apps, seen = [], set()
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            acc = desktop.get_child_at_index(i)
            if acc is None:
                continue
            try:
                pid = acc.get_process_id()
                name = acc.get_name() or ""
            except Exception:
                continue
            if pid <= 0 or pid == os.getpid() or pid in seen or not pid_alive(pid):
                continue
            seen.add(pid)
            exe = exe_name(pid)
            cls = class_by_pid.get(pid)
            bundle = (cls[0] if cls and cls[0] else exe)
            apps.append(App(name or (cls[1] if cls else exe) or "pid %d" % pid, pid, bundle, acc, exe))
        # Windows whose app publishes no tree still belong in the list, so the
        # failure on them can say why instead of "not found".
        for pid, cls in class_by_pid.items():
            if pid in seen or not pid_alive(pid):
                continue
            seen.add(pid)
            exe = exe_name(pid)
            apps.append(App(cls[1] or cls[0] or exe or "pid %d" % pid, pid, cls[0] or exe, None, exe))
        focused = self.x.focused_top()
        focused_pid = next((w["pid"] for w in wins if w["id"] == focused or self.x.top_child(w["win"]) == focused), None)
        apps.sort(key=lambda a: (a.pid != focused_pid, a.name.lower()))
        return apps

    def resolve_app(self, query):
        query = (query or "").strip()
        if not query:
            raise ProviderError("invalid_argument", "app query must not be empty")
        if query.lower() in BLOCKED_APPS:
            raise ProviderError("app_blocked", "app '%s' is blocked for safety" % query)
        apps = self.list_apps()
        match = None
        if query.startswith("pid:") and query[4:].isdigit():
            pid = int(query[4:])
            match = next((a for a in apps if a.pid == pid), None)
        else:
            q = query.lower()
            candidates = [a for a in apps if q in {(a.name or "").lower(), (a.bundle_id or "").lower(), (a.exe or "").lower()}]
            candidates.sort(key=lambda a: a.accessible is None)
            match = candidates[0] if candidates else None
        if match is None:
            # The one Linux-specific fact an agent needs, said where it is needed.
            raise ProviderError(
                "app_not_found",
                "app '%s' not found on display %s. Start GUI apps on this display (DISPLAY=%s <app>), "
                "then run list-apps." % (query, os.environ.get("DISPLAY", "?"), os.environ.get("DISPLAY", ":99")),
            )
        for ident in (match.name, match.bundle_id, match.exe):
            if ident and ident.lower() in BLOCKED_APPS:
                raise ProviderError("app_blocked", "app '%s' is blocked for safety" % query)
        return match

    def windows_for(self, app):
        return [w for w in self.x.toplevels() if w["pid"] == app.pid]

    def list_windows(self, params):
        app = self.resolve_app(params.get("app"))
        focused = self.x.focused_top()
        out = []
        for index, w in enumerate(self.windows_for(app)):
            out.append({
                "index": index, "app": app.info(), "id": w["id"], "title": w["title"],
                "x": w["x"], "y": w["y"], "width": w["width"], "height": w["height"],
                "isMinimized": False, "isOffscreen": False, "screenIndex": 0,
                "isMain": self.x.top_child(w["win"]) == focused,
                "platform": {"wmClass": list(w["class"]) if w["class"][0] else None},
            })
        return {"app": dict(app.info(), isRunning=True, lastUsedAt=None, useCount=None), "windows": out}

    def pick_window(self, app, params):
        wins = self.windows_for(app)
        if not wins:
            raise ProviderError("window_not_found", "app '%s' has no on-screen window" % app.name)
        if params.get("windowId") is not None:
            wid = int(params["windowId"])
            for w in wins:
                if w["id"] == wid:
                    return w
            raise ProviderError("window_not_found", "window %d is not one of %s's windows; run list-windows" % (wid, app.name))
        if params.get("windowIndex") is not None:
            idx = int(params["windowIndex"])
            if 0 <= idx < len(wins):
                return wins[idx]
            raise ProviderError("window_not_found", "window index %d is out of range; %s has %d window(s)" % (idx, app.name, len(wins)))
        focused = self.x.focused_top()
        for w in wins:
            if self.x.top_child(w["win"]) == focused:
                return w
        return wins[0]

    def modal_over(self, app, win, frame):
        """A modal dialog of this app other than the window being read, as
        (title, X window id): the window does not respond until it closes."""
        Atspi = self.atspi
        acc = app.accessible
        if acc is None:
            return None
        S = Atspi.StateType
        others = [w for w in self.windows_for(app) if w["id"] != win["id"]]
        for i in range(acc.get_child_count()):
            child = acc.get_child_at_index(i)
            if child is None or child == frame:
                continue
            try:
                states = child.get_state_set()
                if not (states.contains(S.MODAL) and states.contains(S.SHOWING)):
                    continue
                name = child.get_name() or ""
                ext = Atspi.Component.get_extents(child, Atspi.CoordType.SCREEN)
            except Exception:
                continue
            scored = [(window_match_score((ext.x, ext.y, ext.width, ext.height), name, w), w) for w in others]
            best = max(scored, key=lambda pair: pair[0], default=(0, None))
            if best[1] is not None and best[0] >= 0.5:
                # The window title is what list-windows shows; a GTK message
                # dialog's accessible name is only its kind ("Question").
                return best[1]["title"] or name, best[1]["id"]
        return None

    def frame_for(self, app, win):
        """The AT-SPI window that is this X window: same title, else most overlap."""
        Atspi = self.atspi
        acc = app.accessible
        if acc is None:
            return None
        best, best_score = None, -1.0
        for i in range(acc.get_child_count()):
            child = acc.get_child_at_index(i)
            if child is None:
                continue
            try:
                role = child.get_role_name()
                if role_info(role)[0] != "window":
                    continue
                name = child.get_name() or ""
                ext = Atspi.Component.get_extents(child, Atspi.CoordType.SCREEN)
            except Exception:
                continue
            score = window_match_score((ext.x, ext.y, ext.width, ext.height), name, win)
            if score > best_score:
                best, best_score = child, score
        return best

    # ── snapshots ────────────────────────────────────────────────────────────

    def observe(self, params):
        query = params.get("app")
        with PHASES("resolve"):
            app = self.resolve_app(query)
            win = self.pick_window(app, params)
        if params.get("restoreWindow") is True:
            self.x.activate(win["win"])
            win = next((w for w in self.windows_for(app) if w["id"] == win["id"]), win)
        with PHASES("frame_for"):
            frame = self.frame_for(app, win)
        if frame is None:
            started = process_start(app.pid)
            if self.announced_bus is not None and started is not None and started < self.announced_bus:
                raise ProviderError(
                    "accessibility_error",
                    "'%s' started before display %s announced its accessibility bus (this command just did), so it is not "
                    "on the bus. Restart it on this display and run the command again." % (app.name, os.environ.get("DISPLAY", "?")),
                )
            if app.chromium_like():
                raise ProviderError(
                    "accessibility_error",
                    "'%s' publishes no accessibility tree. Chromium and Electron apps expose one on Linux only when launched "
                    "with --force-renderer-accessibility; relaunch it with that flag." % app.name,
                )
            raise ProviderError(
                "accessibility_error",
                "'%s' publishes no accessibility tree for window %d. GTK apps need the accessibility bridge (libatk-adaptor) and "
                "Qt apps QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1; restart the app after installing or setting it." % (app.name, win["id"]),
            )
        # Chromium publishes its page only once an assistive technology asks
        # the window for its attributes, and may stop after a quiet spell; the
        # launch flag is only a fallback. The call reaches the app whatever
        # libatspi has cached, and the walk right after it reads the page.
        app_round_trip(frame)
        # Read before the walk: an event during it makes the snapshot stale.
        event_mark = self.event_count(app)
        renderer = Renderer(self.atspi, win)
        with PHASES("walk"):
            renderer.render(frame)

        with PHASES("modal"):
            modal = self.modal_over(app, win, frame)
        if modal is not None:
            renderer.lines.insert(min(1, len(renderer.lines)), "\t" + blocked_note(*modal))
        if renderer.count <= 2 and app.chromium_like():
            raise ProviderError(
                "accessibility_error",
                "'%s' exposes an empty accessibility tree. Chromium and Electron apps publish their content on Linux only "
                "when launched with --force-renderer-accessibility; relaunch it with that flag." % app.name,
            )
        title = win["title"] or (frame.get_name() or app.name)
        tree = tree_envelope(app.bundle_id or app.name.replace(" ", "_"), app.pid, title, app.name,
                             renderer.lines, renderer.focused_line)
        shot, status = None, {"state": "skipped", "reason": "no_screenshot_flag"}
        if params.get("noScreenshot") is not True:
            meta = {"engine": "x11", "windowId": win["id"]}
            try:
                captured = self.x.capture(win["x"], win["y"], win["width"], win["height"])
            except Exception as err:
                captured = None
                status = {"state": "failed", "code": "screenshot_failed", "message": "X capture failed: %s" % err, "metadata": meta}
            if captured:
                w, h, png = captured
                shot = {"data": base64.b64encode(png).decode(), "format": "png", "width": w, "height": h, "scale": 1}
                status = {"state": "captured", "metadata": meta}
            elif status["state"] == "skipped":
                status = {"state": "failed", "code": "screenshot_failed", "message": "the window is off screen", "metadata": meta}
        snap = Snapshot(id=str(uuid.uuid4()).upper(), app=app, win=win, title=title, tree=tree,
                        records=renderer.records, focused=renderer.focused_id, truncated=renderer.truncated,
                        depth_reached=renderer.depth_reached, shot=shot, status=status, event_mark=event_mark)
        self.remember(query, app, snap, params.get("windowIndex"))
        return snap

    def render(self, snap):
        win = snap.win
        return {
            "snapshot": {
                "id": snap.id,
                "app": snap.app.info(),
                "window": {"id": win["id"], "title": snap.title, "x": win["x"], "y": win["y"],
                           "width": win["width"], "height": win["height"], "isMinimized": False,
                           "isOffscreen": False, "screenIndex": 0, "platform": {"server": "x11"}},
                "coordinateSpace": "window",
                "treeText": snap.tree,
                "elementCount": len(snap.records),
                "focusedElementId": snap.focused,
                "elements": [{"index": i, "x": r.frame[0], "y": r.frame[1], "width": r.frame[2], "height": r.frame[3]}
                             for i, r in sorted(snap.records.items()) if r.frame],
                "truncation": {"truncated": snap.truncated, "maxNodes": MAX_NODES, "maxDepth": MAX_DEPTH,
                               "maxDepthReached": snap.depth_reached},
            },
            "screenshot": snap.shot,
            "screenshotStatus": snap.status,
        }

    def cache_keys(self, query, app, win_id, window_index):
        keys = ["window-id:%d" % win_id]
        if window_index is not None:
            keys.append("window-index:%d" % int(window_index))
        for sel in (query, app.name, app.bundle_id or "", "pid:%d" % app.pid):
            if not sel:
                continue
            base = sel.lower()
            keys += [base, "%s#window:%d" % (base, win_id)]
            if window_index is not None:
                keys.append("%s#windowindex:%d" % (base, int(window_index)))
        return list(dict.fromkeys(keys))

    def remember(self, query, app, snap, window_index):
        cached = Snapshot(**{k: v for k, v in snap.__dict__.items() if k != "shot"})
        keys = self.cache_keys(query or "", app, snap.win["id"], window_index)
        for key in keys:
            self.snapshots[key] = cached
        self.entries.append((cached.id, keys, time.time()))
        self.prune()

    def prune(self):
        now = time.time()
        while self.entries and (len(self.entries) > CACHE_MAX_ENTRIES or now - self.entries[0][2] > CACHE_MAX_AGE):
            sid, keys, _ = self.entries.pop(0)
            for key in keys:
                if key in self.snapshots and self.snapshots[key].id == sid:
                    del self.snapshots[key]

    def cached(self, params):
        self.prune()
        query = (params.get("app") or "").lower()
        if not query:
            return None
        if params.get("windowId") is not None:
            order = ["window-id:%d" % int(params["windowId"]), "%s#window:%d" % (query, int(params["windowId"]))]
        elif params.get("windowIndex") is not None:
            order = ["window-index:%d" % int(params["windowIndex"]), "%s#windowindex:%d" % (query, int(params["windowIndex"]))]
        else:
            order = [query]
        for key in order:
            if key in self.snapshots:
                return self.snapshots[key]
        return None

    def current(self, params):
        """The snapshot an action works from. The tree the agent read when the
        app has posted no event since, else a fresh walk: cached frames go
        stale when a window moves or a list scrolls."""
        cached = self.cached(params)
        if cached is not None:
            live = next((w for w in self.windows_for(cached.app) if w["id"] == cached.win["id"]), None)
            if live is None:
                raise ProviderError("window_stale", "window %d is no longer available; run get-app-state again to refresh the target window" % cached.win["id"])
            unchanged = self.unchanged_since(cached, live, params)
            if unchanged is not None:
                self.mark_before_action(unchanged, unchanged.event_mark)
                return unchanged
        snap = self.observe(dict(params, noScreenshot=True))
        if params.get("elementIndex") is not None:
            index = int(params["elementIndex"])
            if cached is None:
                raise ProviderError("element_not_found", "element indexes require a fresh get-app-state snapshot for this app and window")
            expected, actual = cached.records.get(index), snap.records.get(index)
            if expected is None or actual is None:
                raise ProviderError("element_not_found", "element %d is stale; run get-app-state again and use a fresh element index" % index)
            if expected.signature != actual.signature:
                raise ProviderError("element_not_found", "element %d changed since the last snapshot; run get-app-state again and use a fresh element index" % index)
        self.mark_before_action(snap, self.event_count(snap.app))
        return snap

    def mark_before_action(self, snap, count):
        self.pre_action_tree = snap.tree
        self.settle_mark = (snap.app, count)
        with PHASES("pre_pixels"):
            pixels = self.x.window_pixels(snap.win)
        self.pre_pixels = (snap.win["id"], pixels) if pixels else None

    def unchanged_since(self, cached, live, params):
        """The cached snapshot, when its app has posted no event since it was
        walked and its window has not moved: every element in it is still the
        one the index named, so the action skips a second walk. Values an app
        changes without an event can be stale here, which an action never
        reads; the frames it may act at are read again."""
        if params.get("restoreWindow") is True or getattr(cached, "event_mark", None) is None:
            return None
        if any(live[k] != cached.win[k] for k in ("x", "y", "width", "height")):
            return None
        if not pid_alive(cached.app.pid) or self.event_count(cached.app) != cached.event_mark:
            return None
        Atspi = self.atspi
        for key in ("elementIndex", "toElementIndex"):
            if params.get(key) is None:
                continue
            record = cached.records.get(int(params[key]))
            if record is None:
                continue
            try:
                ext = Atspi.Component.get_extents(record.acc, Atspi.CoordType.SCREEN)
            except Exception:
                return None
            record.frame = (ext.x - live["x"], ext.y - live["y"], ext.width, ext.height) \
                if ext.width > 0 and ext.height > 0 else None
        cached.win = live
        return cached

    def pixel_change(self, snap):
        """Where the window's pixels changed across the action, and, when they
        did, whether the window went on changing by itself a moment later (a
        spinner, a video, a clock), which makes the first answer noise."""
        if self.pre_pixels is None or self.pre_pixels[0] != snap.win["id"]:
            return None
        after = self.x.window_pixels(snap.win)
        if after is None:
            return None
        changed = changed_rect(self.pre_pixels[1], after)
        repainting = None
        if changed is not None:
            time.sleep(REPAINT_PROBE_SECONDS)
            again = self.x.window_pixels(snap.win)
            repainting = changed_rect(after, again) if again else None
        return {"changed": changed, "repainting": repainting}

    def wait_for_settle(self, path, started=None):
        """Wait for the app's events to go quiet, then make it prove it is
        idle: a quiet spell can be the app busy inside a handler (building a
        dialog), posting nothing until it returns. An AT-SPI call to the app
        is answered from its main loop, so it returns only after that handler,
        and the events the handler posted are queued ahead of the reply."""
        app, before = self.settle_mark or (None, None)
        started = started if started is not None else time.monotonic()
        settle = ActionSettle(path, before, started)
        while True:
            while not settle.is_settled(self.event_count(app) if app is not None else None, time.monotonic()):
                time.sleep(SETTLE_POLL)
            if app is None or settle.last_count is None or time.monotonic() - started >= SETTLE_CEILING:
                return
            if not app_round_trip(app.accessible):
                return
            if self.event_count(app) == settle.last_count:
                return

    def action_result(self, params, run):
        self.pre_action_tree = None
        self.pre_pixels = None
        self.settle_mark = None
        started = time.monotonic()
        action = run(params)
        PHASES.spent["action_total"] = time.monotonic() - started
        # An app updates its tree on its own main loop after the event lands;
        # a read in the same instant reports the old state as "no change".
        with PHASES("settle"):
            self.wait_for_settle(action.get("path"), started)
        try:
            snap = self.observe(params)
            # The app went on changing during the walk (a dialog arriving):
            # settle again and read once more, inside the same ceiling.
            mark = getattr(snap, "event_mark", None)
            if mark is not None and time.monotonic() - started < SETTLE_CEILING \
                    and self.event_count(snap.app) != mark:
                self.settle_mark = (snap.app, mark)
                self.wait_for_settle(action.get("path"))
                snap = self.observe(params)
        except ProviderError as err:
            if err.code not in ("window_not_found", "window_stale") or (params.get("windowId") is None and params.get("windowIndex") is None):
                raise
            snap = self.observe({k: v for k, v in params.items() if k not in ("windowId", "windowIndex")})
            action.setdefault("verification", {"state": "unverified", "reason": "window_changed"})
        result = self.render(snap)
        # Pixels say something only when the tree does not (a canvas, a
        # terminal, an ignored input): the CLI reads them then and only then,
        # so the captures and the repaint probe are paid only then.
        change = None
        if action.get("verification", {}).get("reason") != "window_changed" and self.pre_action_tree == snap.tree:
            with PHASES("pixel_change"):
                change = self.pixel_change(snap)
        if change is not None:
            result["pixelChange"] = change
        action["targetWindowId"] = snap.win["id"]
        result["action"] = action
        if self.pre_action_tree is not None:
            result["baselineTreeText"] = self.pre_action_tree
        return result

    # ── action plumbing ──────────────────────────────────────────────────────

    def element(self, snap, index):
        record = snap.records.get(int(index))
        if record is None:
            raise ProviderError("element_not_found", "element %d is stale; run get-app-state again and use a fresh element index" % int(index))
        return record

    def center(self, snap, record):
        if not record.frame or record.frame[2] <= 0 or record.frame[3] <= 0:
            raise ProviderError("element_not_clickable", "element %d has no clickable frame" % record.index)
        x, y, w, h = record.frame
        return snap.win["x"] + x + w / 2.0, snap.win["y"] + y + h / 2.0

    def point(self, snap, params, xk="x", yk="y"):
        if params.get(xk) is None or params.get(yk) is None:
            raise ProviderError("invalid_argument", "missing %s and %s" % (xk, yk))
        return snap.win["x"] + float(params[xk]), snap.win["y"] + float(params[yk])

    def require_pointer_target(self, snap, x, y, verb):
        """A synthetic pointer event lands on whatever is on top at the point."""
        top = self.x.window_at(int(x), int(y))
        mine = self.x.top_child(snap.win["win"])
        if top is None or top != mine:
            raise ProviderError(
                "window_not_focused",
                "another window covers the %s point in '%s'; retry once with --restore-window to bring it forward" % (verb, snap.app.name),
            )

    def require_keyboard_focus(self, snap):
        if self.x.focused_top() != self.x.top_child(snap.win["win"]):
            raise ProviderError(
                "window_not_focused",
                "'%s' window %d does not have keyboard focus; retry once with --restore-window" % (snap.app.name, snap.win["id"]),
            )

    def focused_record(self, snap):
        return snap.records.get(snap.focused) if snap.focused is not None else None

    def read_text(self, acc):
        Atspi = self.atspi
        try:
            return Atspi.Text.get_text(acc, 0, -1)
        except Exception:
            return None

    def settle_readback(self, acc, want, contains=False):
        deadline = time.time() + 1.0
        actual = self.read_text(acc)
        while time.time() < deadline:
            if actual is not None and ((want in actual) if contains else actual == want):
                break
            time.sleep(0.05)
            actual = self.read_text(acc)
        return actual

    def verification(self, acc, expected, prop="value", contains=False, secure=False):
        if secure:
            # A password field reads back as mask characters, one per character
            # typed; the count is all that can be checked, and all that is shown.
            masked = lambda text: text is not None and len(text) == len(expected) and set(text) <= set("\u2022*\u25cf")
            deadline = time.time() + 1.0
            actual = self.read_text(acc)
            while not masked(actual) and actual != expected and time.time() < deadline:
                time.sleep(0.05)
                actual = self.read_text(acc)
            if masked(actual) or actual == expected:
                return {"state": "verified", "property": prop, "expected": None, "actualPreview": "%d characters" % len(expected)}
            return {"state": "unverified", "reason": "readback_unsupported" if actual is None else "value_mismatch",
                    "expected": None, "actualPreview": None}
        actual = self.settle_readback(acc, expected, contains)
        if actual is None:
            return {"state": "unverified", "reason": "readback_unsupported", "expected": None if secure else expected, "actualPreview": None}
        ok = (expected in actual) if contains else actual == expected
        shown = None if secure else preview(actual, 80)
        if ok:
            return {"state": "verified", "property": prop, "expected": None if secure else expected, "actualPreview": shown}
        return {"state": "unverified", "reason": "value_mismatch", "expected": None if secure else expected, "actualPreview": shown}

    def meta(self, path, action_name=None, fallback=None, verification=None):
        out = {"path": path, "actionName": action_name, "fallbackReason": fallback}
        if verification is not None:
            out["verification"] = verification
        return out

    def do_named_action(self, record, names):
        Atspi = self.atspi
        lowered = [a.lower() for a in record.actions]
        for name in names:
            if name in lowered:
                i = lowered.index(name)
                try:
                    if Atspi.Action.do_action(record.acc, i):
                        return record.actions[i]
                except Exception:
                    return None
        return None

    def synthetic_click(self, snap, x, y, button, count, mods):
        self.require_pointer_target(snap, x, y, "click")
        number = {"left": 1, "middle": 2, "right": 3}[button]
        self.x.move(x, y)
        for m in mods:
            self.x.key(MODIFIER_KEYSYMS[m], True)
        try:
            for _ in range(count):
                self.x.button(number, True)
                self.x.button(number, False)
                time.sleep(0.04)
        finally:
            for m in reversed(mods):
                self.x.key(MODIFIER_KEYSYMS[m], False)

    # ── actions ──────────────────────────────────────────────────────────────

    def click(self, params):
        snap = self.current(params)
        button = (params.get("mouseButton") or "left").lower()
        if button not in ("left", "right", "middle"):
            raise ProviderError("invalid_argument", "mouseButton must be left, right or middle")
        count = int(params.get("clickCount") or 1)
        if count < 1 or count > MAX_CLICK_COUNT:
            raise ProviderError("invalid_argument", "clickCount must be between 1 and %d" % MAX_CLICK_COUNT)
        mods = parse_modifiers(params.get("modifiers"))
        force_mouse = params.get("mouse") is True
        if params.get("elementIndex") is not None:
            record = self.element(snap, params["elementIndex"])
            if not force_mouse and not mods and count == 1 and button != "middle":
                names = ["showcontextmenu", "menu"] if button == "right" else \
                    ["click", "press", "activate", "jump", "toggle", "check", "uncheck", "open", "select", "dodefault"]
                done = self.do_named_action(record, names)
                if done:
                    return self.meta("accessibility", done)
            x, y = self.center(snap, record)
            self.synthetic_click(snap, x, y, button, count, mods)
            return self.meta("synthetic", fallback="mouseRequested" if force_mouse else "actionUnsupported",
                             verification={"state": "unverified", "reason": "synthetic_input"})
        x, y = self.point(snap, params)
        self.synthetic_click(snap, x, y, button, count, mods)
        return self.meta("synthetic", verification={"state": "unverified", "reason": "synthetic_input"})

    def secondary(self, params):
        snap = self.current(params)
        record = self.element(snap, params.get("elementIndex"))
        wanted = (params.get("action") or "").strip()
        match = next((i for i, a in enumerate(record.actions) if pretty_action(a) == wanted.lower() or a.lower() == wanted.lower()), None)
        if match is None:
            raise ProviderError("action_not_supported", "'%s' is not a secondary action advertised by element %d" % (wanted, record.index))
        if not self.atspi.Action.do_action(record.acc, match):
            raise ProviderError("accessibility_error", "the %s action failed" % pretty_action(record.actions[match]))
        return self.meta("accessibility", pretty_action(record.actions[match]))

    def set_value(self, params):
        Atspi = self.atspi
        snap = self.current(params)
        record = self.element(snap, params.get("elementIndex"))
        if "value" not in params or not isinstance(params.get("value"), str):
            raise ProviderError("invalid_argument", "missing value")
        expected = params["value"]
        secure = is_secure(record.node.role, record.node.name, record.node.description, record.node.placeholder)
        if "EditableText" in record.ifaces:
            try:
                ok = Atspi.EditableText.set_text_contents(record.acc, expected)
            except Exception as err:
                ok = False
            if ok:
                return self.meta("accessibility", "setTextContents", verification=self.verification(record.acc, expected, secure=secure))
        if "Value" in record.ifaces and record.node.kind in ("value", "field"):
            try:
                number = float(expected)
            except ValueError:
                raise ProviderError("invalid_argument", "element %d takes a number" % record.index)
            if Atspi.Value.set_current_value(record.acc, number):
                actual = Atspi.Value.get_current_value(record.acc)
                verified = abs(actual - number) < 1e-6
                return self.meta("accessibility", "setCurrentValue", verification={
                    "state": "verified" if verified else "unverified",
                    **({"property": "value"} if verified else {"reason": "value_mismatch"}),
                    "expected": expected, "actualPreview": trim_number(actual)})
        editable = "Text" in record.ifaces and ("editable" in record.node.traits or record.node.kind in ("field", "textarea", "combo"))
        if not editable:
            raise ProviderError("value_not_settable", "element %d does not accept a value write" % record.index)
        # Chromium publishes no EditableText: focus the field, replace its text by typing, read it back.
        self.require_keyboard_focus(snap)
        try:
            Atspi.Component.grab_focus(record.acc)
        except Exception:
            pass
        time.sleep(0.05)
        self.x.chord(["Control_L", "a"])
        if expected == "":
            self.x.chord(["BackSpace"])
        else:
            self.x.type_text(expected)
        return self.meta("synthetic", "typeValue", "valueNotSettable", verification=self.verification(record.acc, expected, secure=secure))

    def type_text(self, params):
        Atspi = self.atspi
        snap = self.current(dict(params, noScreenshot=True))
        text = params.get("text")
        if not isinstance(text, str) or not text:
            raise ProviderError("invalid_argument", "missing text")
        focused = self.focused_record(snap)
        if focused is not None and "EditableText" in focused.ifaces and "Text" in focused.ifaces:
            try:
                caret = Atspi.Text.get_caret_offset(focused.acc)
                if Atspi.Text.get_n_selections(focused.acc) > 0:
                    sel = Atspi.Text.get_selection(focused.acc, 0)
                    Atspi.EditableText.delete_text(focused.acc, sel.start_offset, sel.end_offset)
                    caret = sel.start_offset
                if Atspi.EditableText.insert_text(focused.acc, max(0, caret), text, len(text.encode("utf-8"))):
                    return self.meta("accessibility", "insertText", verification=self.verification(focused.acc, text, "focusedText", contains=True))
            except Exception:
                pass
        self.require_keyboard_focus(snap)
        self.x.type_text(text)
        if focused is not None and "Text" in focused.ifaces:
            v = self.verification(focused.acc, text, "focusedText", contains=True,
                                  secure=is_secure(focused.node.role, focused.node.name, focused.node.description, focused.node.placeholder))
            if v["state"] == "verified":
                return self.meta("synthetic", "typeText", verification=v)
        return self.meta("synthetic", "typeText", verification={"state": "unverified", "reason": "synthetic_input"})

    def press_key(self, params):
        snap = self.current(dict(params, noScreenshot=True))
        key = params.get("key") or ""
        chord = chord_keysyms(key)
        self.require_keyboard_focus(snap)
        self.x.chord(chord)
        return self.meta("synthetic", "pressKey", verification={"state": "unverified", "reason": "synthetic_input"})

    def hotkey(self, params):
        Atspi = self.atspi
        snap = self.current(dict(params, noScreenshot=True))
        key = params.get("key") or ""
        chord = chord_keysyms(key)
        focused = self.focused_record(snap)
        if is_select_all(key) and focused is not None and "Text" in focused.ifaces:
            try:
                length = Atspi.Text.get_character_count(focused.acc)
                ok = Atspi.Text.set_selection(focused.acc, 0, 0, length) if Atspi.Text.get_n_selections(focused.acc) > 0 \
                    else Atspi.Text.add_selection(focused.acc, 0, length)
                if ok:
                    deadline = time.time() + 0.6
                    while True:
                        sel = Atspi.Text.get_selection(focused.acc, 0)
                        verified = sel.start_offset == 0 and sel.end_offset == length
                        if verified or time.time() >= deadline:
                            break
                        time.sleep(0.05)
                    return self.meta("accessibility", "selectAll", verification=(
                        {"state": "verified", "property": "selection", "expected": None, "actualPreview": "%d characters" % length}
                        if verified else {"state": "unverified", "reason": "value_mismatch"}))
            except Exception:
                pass
        self.require_keyboard_focus(snap)
        self.x.chord(chord)
        return self.meta("synthetic", "hotkey", verification={"state": "unverified", "reason": "synthetic_input"})

    def paste_text(self, params):
        Atspi = self.atspi
        snap = self.current(dict(params, noScreenshot=True))
        text = params.get("text")
        if not isinstance(text, str) or not text:
            raise ProviderError("invalid_argument", "missing text")
        if len(text.encode("utf-8")) > PASTE_CAP:
            raise ProviderError("invalid_argument", "paste-text is capped at 16 MiB")
        focused = self.focused_record(snap)
        if focused is not None and "EditableText" in focused.ifaces:
            try:
                caret = Atspi.Text.get_caret_offset(focused.acc)
                if Atspi.EditableText.insert_text(focused.acc, max(0, caret), text, len(text.encode("utf-8"))):
                    return self.meta("accessibility", "insertText", verification=self.verification(focused.acc, text, "focusedText", contains=True))
            except Exception:
                pass
        self.require_keyboard_focus(snap)
        previous = None
        try:
            got = subprocess.run(["xclip", "-selection", "clipboard", "-o"], capture_output=True, timeout=2)
            previous = got.stdout if got.returncode == 0 else None
        except FileNotFoundError:
            raise ProviderError("unsupported_capability", "xclip is not installed (apt install xclip)")
        except subprocess.TimeoutExpired:
            previous = None
        set_clipboard(text.encode("utf-8"))
        time.sleep(0.05)
        self.x.chord(["Control_L", "v"])
        time.sleep(0.2)
        if previous is not None:
            set_clipboard(previous)
        return self.meta("clipboard", "paste", verification={"state": "unverified", "reason": "clipboard_paste"})

    def scroll(self, params):
        snap = self.current(params)
        direction = (params.get("direction") or "").lower()
        buttons = {"up": 4, "down": 5, "left": 6, "right": 7}
        if direction not in buttons:
            raise ProviderError("invalid_argument", "direction must be up, down, left or right")
        pages = float(params.get("pages") or 1)
        if params.get("elementIndex") is not None:
            x, y = self.center(snap, self.element(snap, params["elementIndex"]))
            fallback = "actionUnsupported"
        else:
            x, y = self.point(snap, params)
            fallback = None
        self.require_pointer_target(snap, x, y, "scroll")
        self.x.move(x, y)
        for _ in range(max(1, int(round(pages * WHEEL_CLICKS_PER_PAGE)))):
            self.x.button(buttons[direction], True)
            self.x.button(buttons[direction], False)
            time.sleep(0.01)
        return self.meta("synthetic", fallback=fallback)

    def drag(self, params):
        snap = self.current(params)
        if params.get("elementIndex") is not None:
            x0, y0 = self.center(snap, self.element(snap, params["elementIndex"]))
        else:
            x0, y0 = self.point(snap, params)
        if params.get("toElementIndex") is not None:
            x1, y1 = self.center(snap, self.element(snap, params["toElementIndex"]))
        else:
            x1, y1 = self.point(snap, params, "toX", "toY")
        self.require_pointer_target(snap, x0, y0, "drag")
        self.x.move(x0, y0)
        self.x.button(1, True)
        try:
            steps = 12
            for i in range(1, steps + 1):
                self.x.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)
                time.sleep(0.02)
        finally:
            self.x.button(1, False)
        return self.meta("synthetic", "drag", verification={"state": "unverified", "reason": "synthetic_input"})


def trim_number(value):
    return str(int(value)) if float(value).is_integer() else ("%g" % value)


def set_clipboard(data):
    proc = subprocess.Popen(["xclip", "-selection", "clipboard", "-i"], stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    proc.communicate(data, timeout=5)


# ── the renderer over live AT-SPI ─────────────────────────────────────────────


class Renderer:
    def __init__(self, Atspi, win):
        self.Atspi = Atspi
        self.win = win
        self.lines = []
        self.records = {}
        self.focused_id = None
        self.focused_line = None
        self.truncated = False
        self.depth_reached = False
        self.count = 0
        S = Atspi.StateType
        self.S = S

    def read(self, acc):
        Atspi = self.Atspi
        S = self.S
        role = acc.get_role_name() or "unknown"
        try:
            ifaces = set(acc.get_interfaces() or [])
        except Exception:
            ifaces = set()
        try:
            states = acc.get_state_set()
        except Exception:
            states = None

        def has(state):
            try:
                return bool(states and states.contains(state))
            except Exception:
                return False

        name = acc.get_name() or None
        description = acc.get_description() or None
        kind = role_info(role)[0]
        attrs = {}
        if kind in ("field", "textarea", "combo", "link"):
            # The only attributes the tree shows: a placeholder and a link target.
            try:
                attrs = acc.get_attributes() or {}
            except Exception:
                pass
        placeholder = attrs.get("placeholder") or attrs.get("placeholder-text") or None
        actions = []
        if "Action" in ifaces:
            try:
                actions = [Atspi.Action.get_action_name(acc, i) or "" for i in range(Atspi.Action.get_n_actions(acc))]
            except Exception:
                actions = []
        text = None
        if "Text" in ifaces:
            try:
                count = Atspi.Text.get_character_count(acc)
                text = Atspi.Text.get_text(acc, 0, min(count, 2000)) if count else None
            except Exception:
                text = None
        value = None
        traits = []
        if kind in ("field", "textarea", "combo"):
            value = clean(text)
            if kind == "combo" and not value:
                value = self.selected_option(acc)
            if is_secure(role, name, description, placeholder) and value:
                value = REDACTED
            text = None
        elif kind == "check":
            value = "1" if (has(S.CHECKED) or has(S.PRESSED)) else "0"
        elif kind in ("value", "scrollbar") and "Value" in ifaces:
            try:
                value = trim_number(Atspi.Value.get_current_value(acc))
            except Exception:
                value = None
        url = None
        if kind == "link":
            try:
                link = acc.get_hyperlink()
                url = link.get_uri(0) if link else None
            except Exception:
                url = None
            url = url or attrs.get("href")
        if has(S.SELECTED) and kind in ("tab", "row", "cell", "menuitem", "check"):
            traits.append("selected")
        if has(S.EXPANDED):
            traits.append("expanded")
        if kind in ("button", "check", "field", "textarea", "combo", "menuitem", "tab", "link", "value") and not has(S.ENABLED) and not has(S.SENSITIVE):
            traits.append("disabled")
        if "EditableText" in ifaces or (has(S.EDITABLE) and kind in ("field", "textarea", "combo")):
            traits.append("settable")
        try:
            child_count = acc.get_child_count()
        except Exception:
            child_count = 0
        node = Node(role, name=name, description=description, value=value, placeholder=placeholder, url=url,
                    traits=traits, actions=actions, text=text, child_count=child_count)
        if node.kind == "textarea" and has(S.SINGLE_LINE):
            # GTK reports a one-line entry with the multi-line role.
            node.kind, node.role_text = "field", "text field"
        # VISIBLE, not SHOWING: an element scrolled out of view is still there to
        # act on, while a closed menu or a hidden notification is not.
        return node, ifaces, has(S.FOCUSED), has(S.VISIBLE) or kind == "window"

    def selected_option(self, acc, depth=0):
        """A <select>'s value is the name of its selected option, two levels down."""
        if depth > 2:
            return None
        for child in self.children(acc):
            try:
                if child.get_state_set().contains(self.S.SELECTED) and child.get_name():
                    return child.get_name()
            except Exception:
                continue
            found = self.selected_option(child, depth + 1)
            if found:
                return found
        return None

    def frame(self, acc):
        try:
            ext = self.Atspi.Component.get_extents(acc, self.Atspi.CoordType.SCREEN)
        except Exception:
            return None
        if ext.width <= 0 or ext.height <= 0:
            return None
        return (ext.x - self.win["x"], ext.y - self.win["y"], ext.width, ext.height)

    def children(self, acc, n=None):
        out = []
        try:
            n = acc.get_child_count() if n is None else n
        except Exception:
            return out
        for i in range(n):
            try:
                child = acc.get_child_at_index(i)
            except Exception:
                child = None
            if child is not None:
                out.append(child)
        return out

    def render(self, acc, depth=0, seen=None):
        seen = seen if seen is not None else set()
        if self.count >= MAX_NODES:
            self.truncated = True
            return
        if depth >= MAX_DEPTH:
            self.truncated = True
            self.depth_reached = True
            return
        # The object path is stable per element; a Python id() is not, since a
        # collected wrapper's id is reused and would hide a live node.
        try:
            key = acc.path
        except Exception:
            key = None
        if key:
            if key in seen:
                return
            seen.add(key)
        try:
            node, ifaces, focused, showing = self.read(acc)
        except Exception:
            return
        if not showing and depth > 0:
            return
        kids = self.children(acc, node.child_count)
        if should_elide(node):
            if node.kind != "separator":
                for child in kids:
                    self.render(child, depth, seen)
            return
        index = self.count
        self.count += 1
        line = render_line(index, node)
        self.lines.append("\t" * depth + line)
        self.records[index] = Record(index, acc, self.frame(acc), node.actions, signature(node), node, ifaces)
        if focused:
            self.focused_id = index
            self.focused_line = line
        summary = text_summary(node)
        if should_suppress_children(node, summary):
            return
        if node.kind == "tablist":
            kids = self.compact_tabs(kids, depth + 1)
        if node.kind == "rows":
            # The rows in view first, like the macOS tree, then the rest in order.
            showing = [c for c in kids if self.is_showing(c)]
            shown = showing + [c for c in kids if c not in showing and self.is_visible(c)]
            omitted = len(shown) - MAX_ROWS
            for child in shown[:MAX_ROWS]:
                self.render(child, depth + 1, seen)
            if omitted > 0:
                self.lines.append("\t" * (depth + 1) + "... %d more rows" % omitted)
            return
        for child in kids:
            self.render(child, depth + 1, seen)

    def is_showing(self, acc):
        try:
            return acc.get_state_set().contains(self.S.SHOWING)
        except Exception:
            return False

    def is_visible(self, acc):
        try:
            return acc.get_state_set().contains(self.S.VISIBLE)
        except Exception:
            return False

    def compact_tabs(self, kids, depth):
        tabs = [c for c in kids if (c.get_role_name() or "") == "page tab"]
        if len(tabs) < TAB_STRIP_MIN_TABS:
            return kids
        keep = [c for c in kids if (c.get_role_name() or "") != "page tab" or c.get_state_set().contains(self.S.SELECTED)]
        omitted = len(kids) - len(keep)
        if omitted > 0:
            self.lines.append("\t" * depth + "... %d inactive browser tabs omitted" % omitted)
        return keep


# ── the socket server ─────────────────────────────────────────────────────────


def peer_pid(conn):
    try:
        creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        pid, uid, _ = struct.unpack("3i", creds)
        return pid if uid == os.getuid() else -1
    except Exception:
        return None


def parent_pid(pid):
    try:
        with open("/proc/%d/stat" % pid) as f:
            stat = f.read()
        return int(stat.rsplit(")", 1)[1].split()[1])
    except Exception:
        return None


def daemon_pid():
    for root in (os.environ.get("CODECAST_DIR"), os.path.expanduser("~/.codecast")):
        if not root:
            continue
        try:
            with open(os.path.join(root, "daemon.pid")) as f:
                pid = int(f.read().strip())
                if pid > 1:
                    return pid
        except Exception:
            continue
    return None


def exe_path(pid):
    try:
        return os.path.realpath("/proc/%d/exe" % pid)
    except Exception:
        return None


class Server:
    def __init__(self, socket_path, token, provider):
        self.socket_path = socket_path
        self.token = token
        self.provider = provider
        self.cast_binary = None
        self.conns = {}
        self.authed = set()
        self.claimed = False
        self.started = time.time()
        self.idle_since = None

    def authorize(self, request, pid):
        if request.get("token") != self.token:
            return "invalid computer agent token"
        if pid == -1:
            return "computer agent peer is not authorized"
        claimed = (request.get("params") or {}).get("castBinary")
        claimed = os.path.realpath(claimed) if isinstance(claimed, str) and claimed else None
        binary = self.cast_binary or claimed
        ok = False
        if pid:
            if binary and exe_path(pid) == binary:
                ok = True
            else:
                dpid = daemon_pid()
                current = pid
                for _ in range(4):
                    parent = parent_pid(current)
                    if not parent or parent <= 1:
                        break
                    if parent == dpid:
                        ok = True
                        break
                    current = parent
        if not ok:
            return "computer agent peer is not authorized"
        if self.cast_binary is None and claimed:
            self.cast_binary = claimed
        return None

    def respond(self, request, pid):
        rid = request.get("id")
        denied = self.authorize(request, pid)
        if denied:
            return {"id": rid, "ok": False, "error": {"code": "permission_denied", "message": denied}}, False
        if request.get("method") == "terminate":
            return {"id": rid, "ok": True, "result": {"ok": True}}, True
        try:
            try:
                result = self.provider.handle(request.get("method"), request.get("params") or {})
            finally:
                PHASES.flush(request.get("method"))
            return {"id": rid, "ok": True, "result": result}, True
        except ProviderError as err:
            return {"id": rid, "ok": False, "error": {"code": err.code, "message": err.message}}, True
        except Exception as err:
            return {"id": rid, "ok": False, "error": {"code": "accessibility_error", "message": "%s: %s" % (type(err).__name__, err)}}, True

    def serve(self):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if os.path.exists(self.socket_path):
            import stat as st
            if not st.S_ISSOCK(os.lstat(self.socket_path).st_mode):
                raise SystemExit("refusing to replace a non socket file at the computer socket path")
            os.unlink(self.socket_path)
        listener.bind(self.socket_path)
        os.chmod(self.socket_path, 0o600)
        listener.listen(8)
        buffers = {}
        while True:
            now = time.time()
            if not self.claimed and now - self.started > UNCLAIMED_DEADLINE:
                sys.stderr.write("computer helper received no authenticated session before its deadline\n")
                return
            if self.claimed and not self.authed and self.idle_since and now - self.idle_since > IDLE_DEADLINE:
                return
            readable, _, _ = select.select([listener] + list(buffers.keys()), [], [], IDLE_PUMP_SECONDS)
            self.provider.idle_pump()
            for sock in readable:
                if sock is listener:
                    conn, _ = listener.accept()
                    buffers[conn] = b""
                    self.conns[conn] = peer_pid(conn)
                    continue
                try:
                    chunk = sock.recv(65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    self.drop(sock, buffers)
                    continue
                buffers[sock] += chunk
                while b"\n" in buffers.get(sock, b""):
                    line, rest = buffers[sock].split(b"\n", 1)
                    buffers[sock] = rest
                    try:
                        request = json.loads(line.decode("utf-8"))
                    except Exception:
                        continue
                    response, authed = self.respond(request, self.conns.get(sock))
                    if authed and sock not in self.authed:
                        self.authed.add(sock)
                        self.claimed = True
                        self.idle_since = None
                    try:
                        sock.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode("utf-8"))
                    except OSError:
                        self.drop(sock, buffers)
                        break
                    if authed and request.get("method") == "terminate":
                        return

    def drop(self, sock, buffers):
        buffers.pop(sock, None)
        self.conns.pop(sock, None)
        if sock in self.authed:
            self.authed.discard(sock)
            if not self.authed:
                self.idle_since = time.time()
        try:
            sock.close()
        except OSError:
            pass


# ── entry points ──────────────────────────────────────────────────────────────


def write_private(path, text):
    """0600 and atomic: the CLI polls this file and parses whatever it finds."""
    temp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(temp, path)


def permission_status(path):
    """Linux has no grants to ask for; what stands in for them is whether the
    accessibility bus and the display are reachable from here."""
    prepare_environment()
    status = {"accessibility": "not-granted", "screenshots": "not-granted", "detail": None}
    problems = []
    provider = Provider("0")
    try:
        provider.x.d.get_input_focus()
        status["screenshots"] = "granted"
    except ProviderError as err:
        problems.append(err.message)
    except Exception as err:
        problems.append("the X display is not reachable: %s" % err)
    try:
        provider.atspi.get_desktop(0).get_child_count()
        status["accessibility"] = "granted"
    except ProviderError as err:
        problems.append(err.message)
    except Exception as err:
        problems.append("the accessibility bus is not reachable: %s" % err)
    for tool, package in (("xclip", "xclip"),):
        if not any(os.access(os.path.join(d, tool), os.X_OK) for d in os.environ.get("PATH", "/usr/bin").split(":")):
            problems.append("%s is not installed (apt install %s); paste needs it" % (tool, package))
            status["accessibility"] = "not-granted"
    status["detail"] = "; ".join(problems) or None
    write_private(path, json.dumps(status))


def self_test():
    node = Node("push button", name="Go", actions=["press", "showContextMenu"])
    assert render_line(3, node) == "3 button Go", render_line(3, node)
    entry = Node("entry", name="search", value="hello", placeholder="search", actions=["activate"], traits=["settable"])
    assert render_line(4, entry) == "4 text field (settable) search hello", render_line(4, entry)
    secure = Node("password text", name="Password")
    assert is_secure(secure.role) and role_info("password text")[1] == "secure text field"
    para = Node("paragraph", text="Hello world")
    assert not should_elide(para) and render_line(5, para) == "5 text Hello world", render_line(5, para)
    assert should_suppress_children(para, text_summary(para))
    mixed = Node("paragraph", text="Hello \ufffc world")
    assert should_elide(mixed), "text with an embedded element renders through its children"
    label = Node("label", text="Name \ufffc")
    assert label.kind == "container" and should_elide(label)
    assert should_elide(Node("section", actions=["doDefault", "showContextMenu"]))
    link = Node("link", name="docs", url="https://x.test", actions=["jump"])
    assert render_line(6, link) == "6 link [docs](https://x.test)", render_line(6, link)
    check = Node("check box", name="Agree", value="1", actions=["click"])
    assert render_line(7, check) == "7 check box Agree, Value: 1"
    assert render_line(8, Node("scroll pane", actions=["scrollUp", "scrollDown"])) == "8 scroll area, Secondary Actions: scroll up, scroll down"
    assert chord_keysyms("CmdOrCtrl+A") == ["Control_L", "a"] and chord_keysyms("Shift+Tab") == ["Shift_L", "Tab"]
    assert chord_keysyms("Return") == ["Return"] and chord_keysyms("+") == ["plus"] and chord_keysyms("Ctrl++") == ["Control_L", "plus"]
    assert chord_keysyms("Cmd+Shift+Ctrl+Z") == ["Control_L", "Shift_L", "z"]
    assert char_keysym("a") == 0x61 and char_keysym("\u00e9") == 0xE9 and char_keysym("\u2713") == 0x01002713
    assert char_keysym("\n") == 0xFF0D and char_keysym("\U0001F600") == 0x0101F600
    assert is_select_all("Cmd+A") and not is_select_all("Cmd+Shift+A")
    try:
        chord_keysyms("Ctrl+Shift")
        raise AssertionError("a chord of modifiers only must fail")
    except ProviderError:
        pass
    # Settle: the reaction window when nothing is observed or nothing arrives,
    # a quiet spell after the last event, and the ceiling over both.
    settle = ActionSettle("accessibility", None, 0.0)
    assert not settle.is_settled(None, 0.11) and settle.is_settled(None, 0.12)
    settle = ActionSettle("synthetic", 5, 0.0)
    assert not settle.is_settled(5, 0.2) and settle.is_settled(5, 0.25)
    settle = ActionSettle("accessibility", 5, 0.0)
    assert not settle.is_settled(6, 0.01) and not settle.is_settled(6, 0.05) and settle.is_settled(6, 0.071)
    settle = ActionSettle("accessibility", 0, 0.0)
    for i in range(1, 100):
        if settle.is_settled(i, i * 0.03):
            break
    assert abs(i * 0.03 - SETTLE_CEILING) < 0.031, "events that keep arriving stop at the ceiling"
    png = encode_png(2, 1, bgrx_to_rgb(bytes([0, 0, 255, 0, 255, 0, 0, 0]), 2, 1))
    assert png.startswith(b"\x89PNG") and zlib.decompress(png[png.index(b"IDAT") + 4:-16])[1:4] == b"\xff\x00\x00"
    blank = (4, 2, bytes(32))
    assert changed_rect(blank, (4, 2, bytes(32))) is None
    dot = bytearray(32)
    dot[1 * 16 + 2 * 4 + 1] = 9
    assert changed_rect(blank, (4, 2, bytes(dot))) == {"x": 2, "y": 1, "width": 1, "height": 1}
    dot[0 * 16 + 0] = 9
    assert changed_rect(blank, (4, 2, bytes(dot))) == {"x": 0, "y": 0, "width": 3, "height": 2}
    assert changed_rect(blank, (5, 2, bytes(40))) == {"x": 0, "y": 0, "width": 5, "height": 2}
    assert window_match_score((0, 0, 100, 100), "Save", {"x": 0, "y": 0, "width": 100, "height": 100, "title": "Save"}) == 2.0
    dialog = {"x": 25, "y": 25, "width": 50, "height": 50, "title": "Late dialog"}
    assert window_match_score((25, 25, 50, 50), "Information", dialog) > window_match_score((0, 0, 100, 100), "Main", dialog), \
        "a parent window that covers its dialog must not match the dialog"
    assert blocked_note("Save", 7).endswith("--window-id 7.")
    if os.path.exists("/proc/self/stat"):
        assert process_start(os.getpid()) <= seconds_since_boot()
    tree = tree_envelope("gedit", 42, "Doc", "Text Editor", ["0 standard window Doc"], None)
    assert tree.split("\n")[0] == "App=gedit (pid 42)" and tree.endswith("No UI element is currently focused.")
    print("self-test ok")


def main(argv):
    if not argv:
        sys.stderr.write("the codecast computer helper is launched by `cast computer`, not by hand\n")
        return 13
    if argv[0] == "--self-test":
        self_test()
        return 0
    if argv[0] == "--permission-status-file" and len(argv) >= 2:
        permission_status(argv[1])
        return 0
    if argv[0] == "--agent" and len(argv) >= 2:
        token = None
        version = "0.0.0"
        if "--token-file" in argv:
            try:
                with open(argv[argv.index("--token-file") + 1]) as f:
                    token = f.read().strip()
            except Exception:
                token = None
        if "--provider-version" in argv:
            version = argv[argv.index("--provider-version") + 1]
        if not token:
            sys.stderr.write("codecast-computer --agent requires a non-empty --token-file\n")
            return 2
        prepare_environment()
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        Server(argv[1], token, Provider(version)).serve()
        return 0
    sys.stderr.write("usage: codecast-computer --agent <socket> --token-file <path> [--provider-version <v>]\n")
    return 2


if __name__ == "__main__":
    import signal
    sys.exit(main(sys.argv[1:]))
