#!/usr/bin/env python3
"""Announce the accessibility bus on an X display as the display starts.

    announce-a11y-bus.py <display> [seconds to wait]

An app finds the AT-SPI bus through AT_SPI_BUS_ADDRESS, the AT_SPI_BUS
property on the X root window, or the session bus. An app started on a cloud
host's Xvfb with nothing but DISPLAY has only the root property, so one
started before anything set the property never joins the bus, and cast
computer cannot read it until it is restarted. Qt apps also decide at launch
from org.a11y.Status.IsEnabled. cast-display.service runs this after Xvfb
starts, so both are in place before any app launches.

The address carries the bus's guid, which changes when the bus restarts, so
it is read live from org.a11y.Bus rather than written once. The computer
helper republishes it on first use if it differs.

Exits 0 even when the session bus or display never appears: the helper still
announces the bus itself, and a failure here must not hold the display down.
"""

import os
import sys
import time


def main(argv):
    if not argv:
        sys.stderr.write("usage: announce-a11y-bus.py <display> [seconds to wait]\n")
        return 2
    display = argv[0]
    deadline = time.time() + (float(argv[1]) if len(argv) > 1 else 30.0)
    bus = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid(), "bus")
    xsock = "/tmp/.X11-unix/X" + display.lstrip(":")
    while not (os.path.exists(bus) and os.path.exists(xsock)):
        if time.time() > deadline:
            print("no session bus or display yet; cast computer announces the bus on first use")
            return 0
        time.sleep(0.2)
    os.environ["DISPLAY"] = display
    os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + bus
    try:
        import gi
        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, GLib
        from Xlib import Xatom, display as xdisplay
    except (ImportError, ValueError) as err:
        print("accessibility packages missing (%s); cast computer announces the bus on first use" % err)
        return 0
    conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    address = conn.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None,
                             GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]
    conn.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
                   GLib.Variant("(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))),
                   None, Gio.DBusCallFlags.NONE, 10000, None)
    # The socket appears a moment before the server accepts connections.
    d = None
    while d is None:
        try:
            d = xdisplay.Display(display)
        except Exception:
            if time.time() > deadline:
                print("display %s did not accept a connection; cast computer announces the bus on first use" % display)
                return 0
            time.sleep(0.2)
    d.screen().root.change_property(d.intern_atom("AT_SPI_BUS"), Xatom.STRING, 8, address.encode())
    d.sync()
    print("announced the accessibility bus on %s" % display)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
