// The Modern style (the opt-in third interface style) is drawn on top of the
// Classic primitives: every primitive keeps its Classic classes and adds
// `modern:` ones, which only apply under .modern-style on <html>. These mount
// the main primitives with that class on the root and check the Modern layer
// is there, that tailwind-merge never lets a `modern:` class remove the
// Classic one, and that the empty, loading and error states switch to the
// shared components in Modern only.
import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html class=\"modern-style\"><body></body></html>", { url: "https://app.test/", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  PointerEvent: dom.window.MouseEvent,
  FocusEvent: dom.window.FocusEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  DocumentFragment: dom.window.DocumentFragment,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).getComputedStyle ??= dom.window.getComputedStyle.bind(dom.window);
dom.window.HTMLElement.prototype.scrollIntoView ??= () => {};
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { cn } = await import("../../lib/utils");
const { Button, buttonVariants } = await import("./button");
const { Badge } = await import("./badge");
const { Input } = await import("./input");
const { Switch } = await import("./switch");
const { Tabs, TabsList, TabsTrigger } = await import("./tabs");
const { Popover, PopoverContent, PopoverTrigger } = await import("./popover");
const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await import("./tooltip");
const { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } = await import("./dialog");
const { Sheet, SheetContent, SheetTitle } = await import("./sheet");
const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } = await import("./dropdown-menu");
const { CTX_SURFACE, CtxItem } = await import("./context-menu");
const { modernMenuItem } = await import("./styles");
const { KeyCap } = await import("../KeyCap");
const { SegmentedToggle } = await import("../SegmentedToggle");
const { ThemeContext } = await import("../ThemeProvider");
const { LoadingSkeleton } = await import("../LoadingSkeleton");
const { EmptyState } = await import("../EmptyState");
const { ErrorBoundary } = await import("../ErrorBoundary");

async function mount(node: React.ReactNode): Promise<() => Promise<void>> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  };
}
const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);
const modern = (style: string) => ({ theme: "light", toggleTheme: () => {}, visualStyle: style, setVisualStyle: () => {} }) as any;

describe("tailwind-merge and the modern: variant", () => {
  test("a modern: class never removes the Classic one, and two modern: classes merge", () => {
    expect(cn("rounded-md", "modern:rounded-control").split(" ")).toEqual(["rounded-md", "modern:rounded-control"]);
    expect(cn("h-9 modern:h-control-md", "h-7").split(" ")).toEqual(["modern:h-control-md", "h-7"]);
    expect(cn("bg-popover modern:bg-sol-card", "modern:bg-transparent")).toBe("bg-popover modern:bg-transparent");
    expect(cn("modern:p-3", "modern:p-0")).toBe("modern:p-0");
  });

  test("the token names are known, so a call site's own value replaces them", () => {
    expect(cn("rounded-control", "rounded-lg")).toBe("rounded-lg");
    expect(cn("h-control-md", "h-7")).toBe("h-7");
    expect(cn("shadow-popover", "shadow-none")).toBe("shadow-none");
    expect(cn("duration-press ease-ui", "duration-200 ease-out")).toBe("duration-200 ease-out");
  });
});

describe("the primitives carry their Modern layer", () => {
  test("Button: Classic face kept, Modern radius, ring, height and ink added", async () => {
    const off = await mount(<Button data-b>Go</Button>);
    const c = classes(document.querySelector("[data-b]"));
    expect(c).toContain("rounded-md");
    expect(c).toContain("h-9");
    expect(c).toContain("text-primary-foreground");
    expect(c).toContain("modern:rounded-control");
    expect(c).toContain("modern:h-control-md");
    expect(c).toContain("modern:text-[color:var(--btn-ink)]");
    expect(c).toContain("modern:focus-visible:outline-[color:var(--focus-ring)]");
    await off();
    // Raw buttonVariants() keeps Classic's focus outline style too.
    expect(buttonVariants({ variant: "cyan", size: null }).split(" ")).toContain("focus-visible:outline");
  });

  test("Badge, Input, Switch, Tabs, KeyCap and SegmentedToggle", async () => {
    const off = await mount(
      <div>
        <Badge data-x="badge" variant="secondary">b</Badge>
        <Input data-x="input" />
        <Switch checked={false} onCheckedChange={() => {}} aria-label="s" />
        <Tabs defaultValue="a"><TabsList data-x="tabs"><TabsTrigger value="a">A</TabsTrigger></TabsList></Tabs>
        <KeyCap>K</KeyCap>
        <SegmentedToggle value="a" onChange={() => {}} items={[{ key: "a", label: "A" }, { key: "b", label: "B" }]} />
      </div>,
    );
    expect(classes(document.querySelector("[data-x=badge]"))).toEqual(expect.arrayContaining(["bg-secondary", "modern:rounded-control", "modern:h-5"]));
    expect(classes(document.querySelector("[data-x=input]"))).toEqual(expect.arrayContaining(["h-9", "modern:h-control-md", "modern:bg-sol-card"]));
    expect(classes(document.querySelector("[role=switch]"))).toEqual(expect.arrayContaining(["bg-sol-border", "modern:bg-sol-text/20"]));
    expect(classes(document.querySelector("[data-x=tabs]"))).toEqual(expect.arrayContaining(["bg-muted", "modern:rounded-control"]));
    expect(classes(document.querySelector("kbd"))).toEqual(expect.arrayContaining(["rounded-[4px]", "modern:rounded-[5px]"]));
    const chosen = document.querySelector("[aria-pressed=true]");
    expect(classes(chosen)).toEqual(expect.arrayContaining(["bg-sol-bg-highlight", "modern:bg-sol-card"]));
    await off();
  });

  test("Dialog: a capped, scrolling sheet of paper with a body that scrolls alone", async () => {
    const off = await mount(
      <Dialog open>
        <DialogContent data-x="dialog">
          <DialogHeader><DialogTitle>T</DialogTitle></DialogHeader>
          <DialogBody data-x="body">b</DialogBody>
          <DialogFooter data-x="footer"><button>ok</button></DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const c = classes(document.querySelector("[data-x=dialog]"));
    expect(c).toEqual(expect.arrayContaining(["grid", "bg-background", "modern:flex", "modern:flex-col", "modern:max-h-[calc(100dvh-2rem)]", "modern:overflow-y-auto", "modern:rounded-dialog", "modern:shadow-dialog"]));
    expect(classes(document.querySelector("[data-x=body]"))).toEqual(expect.arrayContaining(["modern:min-h-0", "modern:flex-1", "modern:overflow-y-auto"]));
    expect(classes(document.querySelector("[data-x=footer]"))).toContain("modern:shrink-0");
    await off();
  });

  test("Popover and Tooltip float on the card with the popover shadow", async () => {
    const off = await mount(
      <TooltipProvider>
        <Popover open><PopoverTrigger>p</PopoverTrigger><PopoverContent data-x="pop" className="bg-sol-bg p-0">body</PopoverContent></Popover>
        <Tooltip open><TooltipTrigger>t</TooltipTrigger><TooltipContent data-x="tip">tip</TooltipContent></Tooltip>
      </TooltipProvider>,
    );
    expect(classes(document.querySelector("[data-x=pop]"))).toEqual(expect.arrayContaining(["bg-sol-bg", "p-0", "modern:bg-sol-card", "modern:shadow-popover", "modern:z-[250]"]));
    expect(classes(document.querySelector("[data-x=tip]"))).toEqual(expect.arrayContaining(["bg-primary", "modern:bg-sol-card", "modern:z-[400]"]));
    await off();
  });

  test("a dropdown row and a right-click row get the same Modern row", async () => {
    const off = await mount(
      <DropdownMenu open>
        <DropdownMenuTrigger>t</DropdownMenuTrigger>
        <DropdownMenuContent className={CTX_SURFACE}>
          <DropdownMenuItem data-x="plain">a</DropdownMenuItem>
          <CtxItem data-x="ctx">b</CtxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const plain = classes(document.querySelector("[data-x=plain]"));
    const ctx = classes(document.querySelector("[data-x=ctx]"));
    for (const c of modernMenuItem.split(" ")) {
      expect(plain).toContain(c);
      expect(ctx).toContain(c);
    }
    await off();
  });
});

describe("empty, loading and error states", () => {
  test("LoadingSkeleton: Classic blocks outside Modern, the shared Skeleton in Modern", async () => {
    let off = await mount(<ThemeContext.Provider value={modern("classic")}><LoadingSkeleton /></ThemeContext.Provider>);
    expect(document.querySelector("[data-skeleton]")).toBeNull();
    expect(document.querySelector(".animate-pulse.space-y-4")).not.toBeNull();
    await off();
    off = await mount(<ThemeContext.Provider value={modern("modern")}><LoadingSkeleton /></ThemeContext.Provider>);
    expect(document.querySelectorAll("[data-skeleton]").length).toBe(3);
    await off();
  });

  test("EmptyState: the shared empty state in Modern, its title kept and the sentence behind Details", async () => {
    let off = await mount(<ThemeContext.Provider value={modern("classic")}><EmptyState title="No messages yet" description="Messages land here." /></ThemeContext.Provider>);
    expect(document.querySelector("[data-empty-state]")).toBeNull();
    expect(document.body.textContent).toContain("Messages land here.");
    await off();
    off = await mount(<ThemeContext.Provider value={modern("modern")}><EmptyState title="No messages yet" description="Messages land here." /></ThemeContext.Provider>);
    expect(document.querySelector("[data-empty-state=panel]")).not.toBeNull();
    expect(document.querySelector("details summary")?.textContent).toBe("Details");
    await off();
  });

  test("ErrorBoundary: Classic panel outside Modern, the empty state with Retry and Details in Modern", async () => {
    const Boom = () => { throw new Error("boom"); };
    const quiet = console.error;
    console.error = () => {};
    try {
      document.documentElement.classList.remove("modern-style");
      let off = await mount(<ErrorBoundary name="Panel" silent><Boom /></ErrorBoundary>);
      expect(document.body.textContent).toContain("Panel crashed");
      expect(document.querySelector("[data-empty-state]")).toBeNull();
      await off();
      document.documentElement.classList.add("modern-style");
      off = await mount(<ErrorBoundary name="Panel" silent><Boom /></ErrorBoundary>);
      expect(document.querySelector("[data-error-boundary=Panel] [data-empty-state=panel]")).not.toBeNull();
      expect(document.body.textContent).toContain("Couldn't load Panel");
      expect(document.body.textContent).toContain("Retry");
      expect(document.querySelector("details summary")?.textContent).toBe("Details");
      await off();
    } finally {
      console.error = quiet;
      document.documentElement.classList.add("modern-style");
    }
  });
});

// Two Modern fixes that are not about a look, in Classic and Minimal too: a
// dialog or sheet never outgrows the window (it scrolls, so its buttons stay in
// reach), and a popover opened from a dialog draws above it.
describe("in every style", () => {
  test("a dialog is capped to the window and scrolls; a call site's own cap and overflow win", async () => {
    let off = await mount(<Dialog open><DialogContent data-x="dialog"><DialogTitle>T</DialogTitle></DialogContent></Dialog>);
    let c = classes(document.querySelector("[data-x=dialog]"));
    expect(c).toEqual(expect.arrayContaining(["grid", "max-h-[calc(100dvh-2rem)]", "overflow-y-auto", "modern:max-h-[calc(100dvh-2rem)]", "modern:overflow-y-auto"]));
    await off();
    // FeatureDetail and DeviceSetupDialog pin their own cap and scroll a body of their own.
    off = await mount(<Dialog open><DialogContent data-x="dialog" className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0"><DialogTitle>T</DialogTitle></DialogContent></Dialog>);
    c = classes(document.querySelector("[data-x=dialog]"));
    expect(c).toEqual(expect.arrayContaining(["max-h-[90dvh]", "overflow-hidden", "modern:max-h-[calc(100dvh-2rem)]"]));
    expect(c).not.toContain("max-h-[calc(100dvh-2rem)]");
    expect(c).not.toContain("overflow-y-auto");
    await off();
    // RewindToHere and NewSnippetsBanner: their own cap, the same scroll.
    off = await mount(<Dialog open><DialogContent data-x="dialog" className="max-h-[85vh] overflow-y-auto"><DialogTitle>T</DialogTitle></DialogContent></Dialog>);
    c = classes(document.querySelector("[data-x=dialog]"));
    expect(c).toContain("max-h-[85vh]");
    expect(c).not.toContain("max-h-[calc(100dvh-2rem)]");
    await off();
  });

  test("a sheet scrolls; one from the top or bottom stops short of the far edge", async () => {
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const off = await mount(<Sheet open><SheetContent side={side} data-x="sheet"><SheetTitle>T</SheetTitle></SheetContent></Sheet>);
      const c = classes(document.querySelector("[data-x=sheet]"));
      expect(c).toContain("overflow-y-auto");
      if (side === "top" || side === "bottom") expect(c).toContain("max-h-[calc(100dvh-2rem)]");
      else expect(c).toContain("h-full");
      await off();
    }
  });

  test("a popover sits in the dialog's tier, so one opened from a dialog draws above it; tooltips and menus keep their order", async () => {
    const off = await mount(
      <TooltipProvider>
        <Dialog open>
          <DialogContent data-x="dialog">
            <DialogTitle>T</DialogTitle>
            <Popover open><PopoverTrigger>p</PopoverTrigger><PopoverContent data-x="pop">body</PopoverContent></Popover>
          </DialogContent>
        </Dialog>
        <Tooltip open><TooltipTrigger>t</TooltipTrigger><TooltipContent data-x="tip">tip</TooltipContent></Tooltip>
        <DropdownMenu open><DropdownMenuTrigger>m</DropdownMenuTrigger><DropdownMenuContent data-x="menu"><DropdownMenuItem>a</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </TooltipProvider>,
    );
    const pop = document.querySelector("[data-x=pop]")!;
    const pc = classes(pop);
    // Classic and Minimal: the dialog's z 200 (the lowest that clears it); Modern keeps 250.
    expect(pc).toEqual(expect.arrayContaining(["z-[200]", "modern:z-[250]"]));
    expect(pc).not.toContain("z-50");
    expect(classes(document.querySelector("[data-x=dialog]"))).toContain("z-[200]");
    expect(classes(document.querySelector("[data-x=tip]"))).toContain("z-[200]");
    expect(classes(document.querySelector("[data-x=menu]"))).toContain("z-[250]");
    // At an equal z the later layer draws on top: the popover's layer comes
    // after the dialog's, because it opens from inside it.
    const layerOf = (el: Element) => [...document.body.children].findIndex((c) => c.contains(el));
    expect(layerOf(pop)).toBeGreaterThan(layerOf(document.querySelector("[data-x=dialog]")!));
    // A call site's own tier still wins (cloudAgents/parts sets z-[250]).
    await off();
    const off2 = await mount(<Popover open><PopoverTrigger>p</PopoverTrigger><PopoverContent data-x="pop" className="z-[250]">b</PopoverContent></Popover>);
    expect(classes(document.querySelector("[data-x=pop]"))).not.toContain("z-[200]");
    await off2();
  });
});
