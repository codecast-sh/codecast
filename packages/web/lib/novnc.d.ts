// The part of noVNC's RFB client the host screen pane uses (the package ships no types).
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: { password?: string } });
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    focus(): void;
    disconnect(): void;
    clipboardPasteFrom(text: string): void;
  }
}
