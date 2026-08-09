// Terminal panel geometry constant.
//
// The panel's open state and height used to live here, in their own
// localStorage store, because the terminal is device-local by nature: it only
// exists where a loopback daemon is reachable, so a phone must not inherit an
// open terminal from a desktop.
//
// That reasoning is now expressed IN the layout model instead of outside it —
// the terminal is the `dock` slot, and SLOT_PERSISTENCE marks that slot
// "device", so its arrangement never leaves this browser profile. One layout
// system, with the device-local property stated as data rather than as a
// region that opts out. See store/workspace.ts.

export const DEFAULT_TERMINAL_HEIGHT = 280;
