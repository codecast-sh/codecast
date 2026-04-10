import { create } from "zustand";
import { nanoid } from "nanoid";

// ── Types ──────────────────────────────────────────────────────────────

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState extends WindowBounds {
  id: string;
  sessionId: string;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  /** Saved bounds before maximize, for restore */
  prevBounds?: WindowBounds;
}

export type ArrangeMode = "tile" | "cascade" | "horizontal" | "vertical";

interface WindowManagerState {
  windows: Record<string, WindowState>;
  nextZIndex: number;
  focusedWindowId: string | null;

  // Actions
  openWindow: (sessionId: string, bounds?: Partial<WindowBounds>) => string;
  closeWindow: (id: string) => void;
  closeAll: () => void;
  minimizeWindow: (id: string) => void;
  maximizeWindow: (id: string, viewport: { width: number; height: number }) => void;
  restoreWindow: (id: string) => void;
  toggleMinimize: (id: string) => void;
  bringToFront: (id: string) => void;
  updatePosition: (id: string, x: number, y: number) => void;
  updateSize: (id: string, width: number, height: number) => void;
  updateBounds: (id: string, bounds: Partial<WindowBounds>) => void;
  autoArrange: (mode: ArrangeMode, viewport: { width: number; height: number }) => void;
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 480;
const CASCADE_OFFSET = 32;
const TASKBAR_HEIGHT = 44;
const MIN_WINDOW_W = 360;
const MIN_WINDOW_H = 280;

// ── Helpers ────────────────────────────────────────────────────────────

function nextCascadePosition(windows: Record<string, WindowState>): { x: number; y: number } {
  const count = Object.keys(windows).length;
  return {
    x: 40 + (count % 8) * CASCADE_OFFSET,
    y: 40 + (count % 8) * CASCADE_OFFSET,
  };
}

/** Compute a grid layout for N windows */
function tileLayout(n: number, vw: number, vh: number): WindowBounds[] {
  if (n === 0) return [];
  const usableH = vh - TASKBAR_HEIGHT;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = Math.floor(vw / cols);
  const cellH = Math.floor(usableH / rows);
  const result: WindowBounds[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    result.push({
      x: col * cellW,
      y: row * cellH,
      width: Math.max(cellW, MIN_WINDOW_W),
      height: Math.max(cellH, MIN_WINDOW_H),
    });
  }
  return result;
}

function cascadeLayout(n: number, vw: number, vh: number): WindowBounds[] {
  const w = Math.min(DEFAULT_WIDTH, vw - 100);
  const h = Math.min(DEFAULT_HEIGHT, vh - TASKBAR_HEIGHT - 100);
  return Array.from({ length: n }, (_, i) => ({
    x: 40 + i * CASCADE_OFFSET,
    y: 40 + i * CASCADE_OFFSET,
    width: w,
    height: h,
  }));
}

function horizontalLayout(n: number, vw: number, vh: number): WindowBounds[] {
  if (n === 0) return [];
  const usableH = vh - TASKBAR_HEIGHT;
  const cellW = Math.floor(vw / n);
  return Array.from({ length: n }, (_, i) => ({
    x: i * cellW,
    y: 0,
    width: Math.max(cellW, MIN_WINDOW_W),
    height: usableH,
  }));
}

function verticalLayout(n: number, vw: number, vh: number): WindowBounds[] {
  if (n === 0) return [];
  const usableH = vh - TASKBAR_HEIGHT;
  const cellH = Math.floor(usableH / n);
  return Array.from({ length: n }, (_, i) => ({
    x: 0,
    y: i * cellH,
    width: vw,
    height: Math.max(cellH, MIN_WINDOW_H),
  }));
}

// ── Store ──────────────────────────────────────────────────────────────

export const useWindowManager = create<WindowManagerState>((set, get) => ({
  windows: {},
  nextZIndex: 1,
  focusedWindowId: null,

  openWindow(sessionId, bounds) {
    const state = get();
    // If already open for this session, just bring to front
    const existing = Object.values(state.windows).find(w => w.sessionId === sessionId);
    if (existing) {
      if (existing.minimized) get().restoreWindow(existing.id);
      get().bringToFront(existing.id);
      return existing.id;
    }

    const id = nanoid(8);
    const pos = nextCascadePosition(state.windows);
    const win: WindowState = {
      id,
      sessionId,
      x: bounds?.x ?? pos.x,
      y: bounds?.y ?? pos.y,
      width: bounds?.width ?? DEFAULT_WIDTH,
      height: bounds?.height ?? DEFAULT_HEIGHT,
      zIndex: state.nextZIndex,
      minimized: false,
      maximized: false,
    };
    set({
      windows: { ...state.windows, [id]: win },
      nextZIndex: state.nextZIndex + 1,
      focusedWindowId: id,
    });
    return id;
  },

  closeWindow(id) {
    const { [id]: _, ...rest } = get().windows;
    const focused = get().focusedWindowId === id ? null : get().focusedWindowId;
    set({ windows: rest, focusedWindowId: focused });
  },

  closeAll() {
    set({ windows: {}, focusedWindowId: null, nextZIndex: 1 });
  },

  minimizeWindow(id) {
    const win = get().windows[id];
    if (!win) return;
    set({
      windows: { ...get().windows, [id]: { ...win, minimized: true } },
      focusedWindowId: get().focusedWindowId === id ? null : get().focusedWindowId,
    });
  },

  maximizeWindow(id, viewport) {
    const win = get().windows[id];
    if (!win) return;
    const prevBounds: WindowBounds = { x: win.x, y: win.y, width: win.width, height: win.height };
    set({
      windows: {
        ...get().windows,
        [id]: {
          ...win,
          maximized: true,
          minimized: false,
          prevBounds,
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height - TASKBAR_HEIGHT,
          zIndex: get().nextZIndex,
        },
      },
      nextZIndex: get().nextZIndex + 1,
      focusedWindowId: id,
    });
  },

  restoreWindow(id) {
    const win = get().windows[id];
    if (!win) return;
    const restored = win.prevBounds ?? { x: win.x, y: win.y, width: win.width, height: win.height };
    set({
      windows: {
        ...get().windows,
        [id]: {
          ...win,
          minimized: false,
          maximized: false,
          ...restored,
          zIndex: get().nextZIndex,
        },
      },
      nextZIndex: get().nextZIndex + 1,
      focusedWindowId: id,
    });
  },

  toggleMinimize(id) {
    const win = get().windows[id];
    if (!win) return;
    if (win.minimized) {
      get().restoreWindow(id);
    } else {
      get().minimizeWindow(id);
    }
  },

  bringToFront(id) {
    const win = get().windows[id];
    if (!win) return;
    set({
      windows: {
        ...get().windows,
        [id]: { ...win, zIndex: get().nextZIndex },
      },
      nextZIndex: get().nextZIndex + 1,
      focusedWindowId: id,
    });
  },

  updatePosition(id, x, y) {
    const win = get().windows[id];
    if (!win) return;
    set({
      windows: { ...get().windows, [id]: { ...win, x, y, maximized: false } },
    });
  },

  updateSize(id, width, height) {
    const win = get().windows[id];
    if (!win) return;
    set({
      windows: { ...get().windows, [id]: { ...win, width, height, maximized: false } },
    });
  },

  updateBounds(id, bounds) {
    const win = get().windows[id];
    if (!win) return;
    set({
      windows: {
        ...get().windows,
        [id]: { ...win, ...bounds, maximized: false },
      },
    });
  },

  autoArrange(mode, viewport) {
    const state = get();
    const visible = Object.values(state.windows).filter(w => !w.minimized);
    if (visible.length === 0) return;

    const layoutFn = { tile: tileLayout, cascade: cascadeLayout, horizontal: horizontalLayout, vertical: verticalLayout }[mode];
    const positions = layoutFn(visible.length, viewport.width, viewport.height);

    const updated = { ...state.windows };
    visible.forEach((win, i) => {
      updated[win.id] = {
        ...win,
        ...positions[i],
        maximized: false,
        prevBounds: undefined,
        zIndex: state.nextZIndex + i,
      };
    });
    set({
      windows: updated,
      nextZIndex: state.nextZIndex + visible.length,
    });
  },
}));

export const TASKBAR_HEIGHT_PX = TASKBAR_HEIGHT;
