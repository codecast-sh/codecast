/**
 * The `cast computer` wire shapes.
 *
 * These are the helper's JSON and also the CLI's `--json`: the client passes a
 * result through unchanged except for the screenshot rewrite A4 owns. Section 6
 * of the design (ct-49518) is the contract; the Swift helper (ct-49519)
 * produces these and never anything else.
 */

export type ComputerErrorCode =
  | "app_not_found"
  | "app_blocked"
  | "window_not_found"
  | "window_not_focused"
  | "window_stale"
  | "provider_incompatible"
  | "unsupported_capability"
  | "permission_denied"
  | "element_not_found"
  | "element_not_clickable"
  | "action_not_supported"
  | "value_not_settable"
  | "invalid_argument"
  | "action_timeout"
  | "screenshot_failed"
  | "accessibility_error";

export type ComputerAppInfo = { name: string; bundleId: string | null; pid: number };

export type ComputerWindowInfo = {
  id?: number | null;
  index?: number | null;
  title: string;
  x?: number | null;
  y?: number | null;
  width: number;
  height: number;
  isMinimized?: boolean | null;
  isOffscreen?: boolean | null;
  screenIndex?: number | null;
  platform?: Record<string, unknown>;
};

export type ComputerSnapshotData = {
  id: string;
  app: ComputerAppInfo;
  window: ComputerWindowInfo;
  coordinateSpace: "window";
  treeText: string;
  elementCount: number;
  focusedElementId: number | null;
  truncation?: { truncated: boolean; maxNodes?: number; maxDepth?: number; maxDepthReached?: boolean };
};

export type ComputerScreenshotData = {
  /** base64 png on the wire; the CLI replaces it with `path` in --json. */
  data?: string;
  format: "png";
  width: number;
  height: number;
  /** Screenshot pixels per window point: action_x = pixel_x / scale. */
  scale: number;
  path?: string;
  dataOmitted?: boolean;
  expiresAt?: string;
};

export type ComputerScreenshotStatus =
  | { state: "captured"; metadata?: { engine?: "cgWindowList" | "screenCaptureKit" | "unknown"; windowId?: number | null } }
  | { state: "skipped"; reason: "no_screenshot_flag" }
  | { state: "failed"; code: ComputerErrorCode; message: string; metadata?: { engine?: string; windowId?: number | null } };

export type ComputerActionVerification =
  | { state: "verified"; property: "focusedText" | "selection" | "value"; expected?: string | null; actualPreview?: string | null }
  | {
      state: "unverified";
      reason:
        | "synthetic_input"
        | "clipboard_paste"
        | "accessibility_action_unasserted"
        | "provider_unavailable"
        | "readback_unsupported"
        | "window_changed"
        | "value_mismatch";
      expected?: string | null;
      actualPreview?: string | null;
    };

export type ComputerActionMetadata = {
  path: "accessibility" | "synthetic" | "clipboard";
  actionName?: string | null;
  fallbackReason?: string | null;
  targetWindowId?: number | null;
  targetWindowIndex?: number | null;
  verification?: ComputerActionVerification;
};

export type ComputerSnapshotResult = {
  snapshot: ComputerSnapshotData;
  screenshot: ComputerScreenshotData | null;
  screenshotStatus: ComputerScreenshotStatus;
};

export type ComputerActionResult = ComputerSnapshotResult & { action?: ComputerActionMetadata };

export type ComputerProviderCapabilities = {
  platform: "darwin";
  provider: string;
  /** The CLI version the helper was built with; a mismatch relaunches it. */
  providerVersion: string;
  protocolVersion: number;
  supports: {
    apps: { list: boolean; bundleIds: boolean; pids: boolean };
    windows: { list: boolean; targetById: boolean; targetByIndex: boolean; focus: boolean; moveResize: boolean };
    observation: { screenshot: boolean; annotatedScreenshot: boolean; elementFrames: boolean; ocr: boolean };
    actions: {
      click: boolean;
      typeText: boolean;
      pressKey: boolean;
      hotkey: boolean;
      pasteText: boolean;
      scroll: boolean;
      drag: boolean;
      setValue: boolean;
      performAction: boolean;
    };
    surfaces: { menus: boolean; dialogs: boolean; dock: boolean; menubar: boolean };
  };
};

export type ComputerListAppsResult = {
  apps: (ComputerAppInfo & { isRunning: boolean; lastUsedAt: string | null; useCount: number | null })[];
};

export type ComputerListWindowsResult = {
  app: ComputerAppInfo;
  windows: (ComputerWindowInfo & { app: ComputerAppInfo; index: number; isMain?: boolean | null })[];
};

/** Every method the helper answers. `terminate` is the only one with no result. */
export type ComputerMethod =
  | "handshake"
  | "listApps"
  | "listWindows"
  | "getAppState"
  | "click"
  | "performSecondaryAction"
  | "scroll"
  | "typeText"
  | "pressKey"
  | "hotkey"
  | "pasteText"
  | "setValue"
  | "terminate";

export type ComputerActionMethod = Exclude<ComputerMethod, "handshake" | "listApps" | "listWindows" | "getAppState" | "terminate">;

export type ComputerRequest = { id: number; method: ComputerMethod; params: unknown; token: string };

export type ComputerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: ComputerErrorCode; message: string } };

export const COMPUTER_PROTOCOL_VERSION = 1;

/** Both TCC grants the helper asks for, and nothing else asks for. */
export type ComputerPermissionId = "accessibility" | "screenshots";
export type ComputerPermissionStatus = "granted" | "not-granted" | "unsupported";

export type ComputerPermissionStatusResult = {
  platform: NodeJS.Platform;
  helperAppPath: string | null;
  helperUnavailableReason: string | null;
  permissions: { id: ComputerPermissionId; status: ComputerPermissionStatus }[];
};
