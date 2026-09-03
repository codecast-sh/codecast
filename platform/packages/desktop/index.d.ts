// Type surface for @platform/desktop. The implementation is plain CommonJS.

export interface ShortcutSettings {
  DEFAULT_SHORTCUTS: Record<string, string>;
  /** Persisted `shortcuts` from settings.json (may be undefined) → effective bindings. */
  mergeShortcuts(persisted: Record<string, string> | undefined): Record<string, string>;
  /** Effective bindings → the object to persist (overrides only). */
  diffOverrides(shortcuts: Record<string, string>): Record<string, string>;
}

export interface MenuItemSpec { label: string; path: string }
export interface HelpLinkSpec { label: string; url: string }

export interface DesktopConfigInput {
  /** Window title, menus, the .app bundle name ("Codecast"). */
  productName: string;
  /** Reverse DNS bundle id ("sh.codecast.desktop"). */
  appId: string;
  /** Deep link scheme ("codecast" → codecast://…). */
  protocol: string;
  /** Lowercase token that derives the bridge global, event names and env prefix. Defaults to `protocol`. */
  slug?: string;
  /** Env var prefix: <PREFIX>_URL, <PREFIX>_USER_DATA, <PREFIX>_CLAIM_PROTOCOL. Defaults from slug. */
  envPrefix?: string;
  urls: { prod: string; local?: string };
  /** Extra hostnames that count as first party for permission grants. */
  trustedHosts?: string[];
  /** window[<bridgeGlobal>] in the renderer. Default `__<SLUG>_ELECTRON__`. */
  bridgeGlobal?: string;
  events?: {
    /** CustomEvent name the shell dispatches to navigate. Default `<slug>-navigate`. */
    navigate?: string;
    /** window global the shell calls for "New Session". Default `__<SLUG>_NEW_SESSION`. */
    newSession?: string;
    /** Class added to <html> in every window. Default `electron-desktop`. */
    htmlClass?: string;
  };
  assets?: { icon?: string; tray?: string };
  window?: {
    width?: number; height?: number; minWidth?: number; minHeight?: number;
    backgroundColor?: string; trafficLightPosition?: { x: number; y: number };
    /** Persist size and position in settings.json. Default true. */
    rememberBounds?: boolean;
  };
  menu?: {
    navItems?: MenuItemSpec[];
    helpLinks?: HelpLinkSpec[];
    settingsPath?: string;
    /** Label for the New Session entries; null removes them. Default "New Session". */
    newSessionLabel?: string | null;
    dockItems?: MenuItemSpec[];
  };
  /** Floating palette window. Absent = no palette. */
  palette?: { path: string; width?: number; height?: number } | null;
  shortcuts?: {
    defaults?: Record<string, string>;
    /** Inject @platform/keys' implementation; a plain merge/diff is used otherwise. */
    settings?: ShortcutSettings;
    /** Extra shortcut actions by key; each receives the shell API. */
    actions?: Record<string, (api: DesktopAppApi) => void>;
  };
  notificationRouter?: NotificationRouterOptions;
  update?: {
    enabled?: boolean;
    /** Feed base: `${baseUrl}/${channel}-mac.yml` and the zips live here. */
    baseUrl?: string;
    /** electron-builder channel; "latest" → latest-mac.yml. */
    channel?: string;
    /** Apple Team ID the downloaded bundle must be signed by. */
    teamId?: string;
    /** The kill switch source: resolves the fleet's minimum version or null. */
    minVersion?: () => Promise<string | null> | string | null;
    initialDelayMs?: number;
    intervalMs?: number;
  };
  extraPermissions?: string[];
  about?: { copyright?: string; website?: string };
  /** The offline copy of the site: served from userData, refreshed from `manifestPath` whenever online. */
  web?: {
    cache?: boolean;
    /** Where the site publishes its release manifest (the `@platform/desktop/vite` plugin writes it). Default "/release.json". */
    manifestPath?: string;
    /** A copy of the site packaged with the app (electron-builder `extraResources`), used before the first download. */
    seedDir?: string | null;
    /** Path prefixes the app's server owns (`/api/`): always fetched, never served from the copy. */
    passthrough?: string[];
    checkIntervalMs?: number;
    /** How long a launch waits for the manifest check before painting the copy it has. Default 6000. */
    startupTimeoutMs?: number;
  };
  /** URL schemes beyond `protocol` (a mail app: mailto). Listed in the bundle; claimable as the OS default. */
  extraProtocols?: Array<{ scheme: string; name?: string; claimOnFirstRun?: boolean; menuLabel?: string }>;
  hooks?: {
    /** Runs once the shell is up (windows, menus, cache, updater), with the API; `firstRun` on a profile's first launch. */
    onReady?: (api: DesktopAppApi, info: { firstRun: boolean }) => void;
  };
  /** URLs the page opens that are downloads, not pages: saved by the shell instead of opened in the browser. */
  downloadUrls?: (url: string) => boolean;
}

export interface DesktopConfig {
  productName: string; appId: string; protocol: string; slug: string; envPrefix: string;
  env: { url: string; userData: string; claimProtocol: string };
  urls: { prod: string; local: string | null };
  localDevHost: string | null;
  trustedHosts: string[];
  bridgeGlobal: string;
  events: { navigate: string; newSession: string; htmlClass: string };
  assets: { icon: string | null; tray: string | null };
  window: Required<NonNullable<DesktopConfigInput["window"]>> & { rememberBounds: boolean };
  web: { cache: boolean; manifestPath: string; seedDir: string | null; passthrough: string[]; checkIntervalMs: number; startupTimeoutMs: number };
  extraProtocols: Array<{ scheme: string; name: string; claimOnFirstRun: boolean; menuLabel: string | null }>;
  hooks: { onReady: ((api: DesktopAppApi, info: { firstRun: boolean }) => void) | null };
  downloadUrls: ((url: string) => boolean) | null;
  menu: { navItems: MenuItemSpec[]; helpLinks: HelpLinkSpec[]; settingsPath: string | null; newSessionLabel: string | null; dockItems: MenuItemSpec[] };
  palette: { path: string; width: number; height: number } | null;
  shortcuts: { defaults: Record<string, string>; settings: ShortcutSettings; actions: Record<string, (api: DesktopAppApi) => void> };
  notificationRouter: DesktopConfigInput["notificationRouter"] | null;
  update: { enabled: boolean; baseUrl: string | null; channel: string; teamId: string | null; minVersion: DesktopConfigInput["update"] extends infer U ? (U extends { minVersion?: infer M } ? M | null : never) : never; initialDelayMs: number; intervalMs: number };
  permissions: string[];
  about: { copyright: string; website: string };
}

export class DesktopConfigError extends Error {}
export function resolveDesktopConfig(input: DesktopConfigInput): DesktopConfig;
export const BASELINE_PERMISSIONS: string[];
export function plainShortcutSettings(defaults: Record<string, string>): ShortcutSettings;

export interface DesktopAppApi {
  config: DesktopConfig;
  getMainWindow(): unknown;
  navigateMain(path: string): void;
  showNotification(title: string, body: string, onClick?: () => void): void;
  checkForUpdate(opts?: { manual?: boolean; userInitiated?: boolean; force?: boolean }): Promise<void>;
  installUpdateAndRestart(): void;
  togglePalette(): void;
  showCompose(): void;
  openFullSessionInMain(): void;
  toggleEnvironment(): void;
  /** Check the site manifest now; resolves the refresh result (null when the copy is off). */
  refreshWeb(): Promise<WebRefreshResult | null>;
  webRelease(): WebRelease | null;
  /** Ask the OS to make this app the handler for one of `extraProtocols`; true when it is afterwards. */
  claimDefaultClient(scheme: string): boolean;
}

export type WebRelease = { release: string; dir: string };
export type WebRefreshResult = { status: "fresh" | "updated" | "offline" | "error"; release: string | null; from?: string | null; error?: string };

/** Main process entry. Call once at the top of main.js; `electron` defaults to require("electron"). */
export function createDesktopApp(config: DesktopConfigInput, electron?: unknown): DesktopAppApi;

// ── Renderer bridge ────────────────────────────────────────────────────────

export type UpdateStatus = { status: "available" | "downloading" | "ready" | "error" | string; version?: string; percent?: number };
export type NotifyNativeData = { conversationId?: string; route?: string; key?: string; kind?: string };
export type DesktopWindowState = { active: string | null; open: Array<{ id?: string | null; path: string }>; inCall?: boolean };
export type DesktopWindowRole = { leader: boolean; appFocused: boolean; anyInCall: boolean };
export type DesktopDisplaySource = { id: string; name: string; kind: "screen" | "window"; thumbnail: string };
export type DesktopShortcutConfig = { shortcuts: Record<string, string>; defaults: Record<string, string>; issues: Record<string, string> };

/** What the renderer sees on window[<bridgeGlobal>]. */
export interface DesktopBridge {
  getVersion(): Promise<string>;
  setBadgeCount(count: number): Promise<void>;
  getEnv(): Promise<"prod" | "local">;
  onDeepLink(cb: (url: string) => void): void;
  onUpdateStatus(cb: (status: UpdateStatus) => void): void;
  restartForUpdate(): Promise<void>;
  checkForUpdate(opts?: { manual?: boolean }): Promise<void>;
  /** The offline copy moved to a newer release than this page loaded from; reload when convenient. */
  onWebUpdate(cb: (info: { release: string; from: string | null }) => void): void;
  getWebRelease(): Promise<WebRelease | null>;
  refreshWeb(): Promise<WebRefreshResult | null>;
  setAsDefaultClient(scheme: string): Promise<boolean>;
  isDefaultClient(scheme: string): Promise<boolean>;
  showNotification(title: string, body: string, data?: NotifyNativeData): Promise<{ shown: boolean; reason?: string }>;
  reportWindowState(state: DesktopWindowState): void;
  onWindowRole(cb: (role: DesktopWindowRole) => void): void;
  getShortcuts(): Promise<Record<string, string>>;
  getShortcutConfig(): Promise<DesktopShortcutConfig>;
  setShortcut(key: string, accelerator: string): Promise<Record<string, string>>;
  paletteNavigate(path: string): void;
  paletteHide(): void;
  paletteNewSession(): void;
  paletteReady(mode: "compose" | "search"): void;
  onPaletteShow(cb: () => void): () => void;
  onComposeShow(cb: () => void): () => void;
  composeSubmit(data: { conversationId?: string; navigate: boolean }): void;
  openExternal(url: string): Promise<void>;
  getSystemIdleSeconds(): Promise<number>;
  getDisplaySources(opts?: { types?: Array<"screen" | "window"> }): Promise<DesktopDisplaySource[]>;
  selectDisplaySource(id: string | null): Promise<boolean>;
  hostPolicy(patch?: { permissions?: string[]; hosts?: string[] }): Promise<{ permissions: string[]; hosts: string[]; version: string } | null>;
  isTabWindow: boolean;
  detachTab(path: string): Promise<void>;
  attachTab(path: string): Promise<void>;
  onAdoptTab(cb: (path: string) => void): void;
  platform: string;
}

export interface IpcRendererLike {
  on(channel: string, listener: (event: unknown, payload?: any) => void): void;
  removeListener(channel: string, listener: (...args: any[]) => void): void;
  invoke(channel: string, ...args: any[]): Promise<any>;
  send(channel: string, ...args: any[]): void;
}
export function createBridge(opts: { ipcRenderer: IpcRendererLike; argv?: string[]; platform?: string }): DesktopBridge;
export function bufferedChannel(ipcRenderer: IpcRendererLike, channel: string, opts?: { latest?: boolean }): (cb: (payload: any) => void) => void;
export const BRIDGE_METHODS: string[];
export const preloadPath: string;

// ── Notification routing ───────────────────────────────────────────────────

export interface WindowDescriptor {
  id: number; isMain: boolean; focused: boolean; lastFocusedAt: number;
  active: string | null; open: Array<{ id: string | null; path: string }>; inCall: boolean;
  /** Apps add their own window facts here for windowBonus/preferredLeader to read. */
  [key: string]: unknown;
}
export type NotificationTarget = { route?: string | null; kind?: string | null } | null;
export interface NotificationRouterOptions {
  areas?: Array<[string, string[]]>;
  entityQueryParams?: Record<string, string>;
  /**
   * Asked before every route rule. Return a number to settle a window's score,
   * anything else to fall through — how a window that owns the ringer claims
   * banners by KIND rather than by route.
   */
  windowBonus?: (win: WindowDescriptor, target: NotificationTarget) => number | null | undefined;
  /** Asked before the focused-window rule; a window returned here leads the sounds. */
  preferredLeader?: (windows: WindowDescriptor[]) => WindowDescriptor | null | undefined;
}
export interface NotificationRouter {
  areaOf(path: string | null | undefined): string | null;
  classifyRoute(route: string | null | undefined): { area: string | null; id: string | null };
  sameEntity(a: string | null | undefined, b: string | null | undefined): boolean;
  scoreWindow(win: WindowDescriptor, target: { route?: string | null; kind?: string | null } | null): number;
  pickWindow(windows: WindowDescriptor[], target: { route?: string | null; kind?: string | null } | null): { window: WindowDescriptor; tabId: string | null } | null;
  chooseLeader(windows: WindowDescriptor[]): WindowDescriptor | null;
  RecentKeys: typeof RecentKeys;
}
export class RecentKeys {
  constructor(ttlMs?: number, now?: () => number);
  static keyFor(payload: { title?: string; body?: string; data?: NotifyNativeData } | null | undefined): string;
  claim(key: string): boolean;
}
export function createNotificationRouter(opts?: NotificationRouterOptions): NotificationRouter;
export const notificationRouter: NotificationRouter & {
  createNotificationRouter: typeof createNotificationRouter;
  DEFAULT_AREA_PREFIXES: Array<[string, string[]]>;
  DEFAULT_ENTITY_QUERY_PARAMS: Record<string, string>;
};

// ── Updater ────────────────────────────────────────────────────────────────

export const updaterNet: {
  getFollow(url: string, opts?: { redirects?: number; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<any>;
  fetchText(url: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string>;
  /** Resolves with the file's sha512 (base64). */
  downloadResumable(url: string, dest: string, opts?: {
    onProgress?: (percent: number) => void; signal?: AbortSignal;
    attempts?: number; inactivityMs?: number; retryDelayMs?: number;
  }): Promise<string>;
};

// ── Offline copy of the site ───────────────────────────────────────────────
export interface WebCache {
  init(): WebRelease | null;
  current(): WebRelease | null;
  refresh(opts?: { signal?: AbortSignal }): Promise<WebRefreshResult>;
  resolve(pathname: string): string | null;
  indexFile(): string | null;
  dir: string;
  origin: string;
}
export function createWebCache(opts: {
  dir: string; origin: string; manifestPath?: string; seedDir?: string | null;
  fetchImpl?: typeof fetch; concurrency?: number; log?: (line: string) => void;
}): WebCache;
export const webCache: {
  createWebCache: typeof createWebCache;
  parseManifest(text: string): { release: string; commit: string | null; files: Record<string, string | null> };
  planRequest(o: { method: string; url: string; appHosts: Set<string>; cache: WebCache; passthrough?: string[]; headers?: Record<string, string> }):
    { kind: "file"; file: string } | { kind: "network"; fallback: "offline-page" | null };
  releaseIdFor(files: Record<string, string | null>): string;
};

export const updaterLogic: {
  cmpVersions(a: string, b: string): -1 | 0 | 1;
  feedFileName(channel?: string, platform?: string): string;
  feedUrlFor(baseUrl: string, channel?: string, platform?: string): string;
  parseFeed(text: string): { version?: string; zip?: string; sha512?: string };
  shouldDownload(o: { feedVersion?: string; installedVersion: string; force?: boolean }): boolean;
  mustApplyNow(o: { installedVersion: string; minVersion: string | null | undefined }): boolean;
  decideUpdate(o: { feed: { version?: string; zip?: string; sha512?: string } | null; installedVersion: string; force?: boolean; platform?: string; packaged?: boolean }): { action: "skip" | "download"; reason: string };
  swapScript(o: { pid: number; bundlePath: string; incomingPath: string; oldPath: string }): string;
};

// ── Build ──────────────────────────────────────────────────────────────────

export const NOTARIZE_ENV: { keychainProfile: "NOTARIZE_KEYCHAIN_PROFILE"; appleId: "APPLE_ID"; applePassword: "APPLE_PASSWORD"; appleTeamId: "APPLE_TEAM_ID" };
export function notarizeCredentials(env?: Record<string, string | undefined>):
  | { kind: "keychainProfile"; keychainProfile: string }
  | { kind: "appleId"; appleId: string; appleIdPassword: string; teamId?: string }
  | null;
/** electron-builder afterSign hook. `notarize` overrides @electron/notarize (tests). */
export function createNotarizeHook(opts?: {
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  notarize?: (o: Record<string, unknown>) => Promise<void>;
}): (context: { electronPlatformName: string; appOutDir: string; packager: { appInfo: { productFilename: string } } }) => Promise<void>;
