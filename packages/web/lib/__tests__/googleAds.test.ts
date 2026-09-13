import { beforeEach, describe, expect, test } from "bun:test";

// Under bun, import.meta.env IS process.env, so the module under test reads
// whatever these tests set. googleAds.ts reads the variable on each call rather
// than capturing it at module load, so one import serves every case here.
//
// There is no DOM library in this package, and the module touches only four
// browser APIs, so the stub below is the whole environment it needs.
delete process.env.VITE_GOOGLE_ADS_SEND_TO;

const SEND_TO = "AW-11465219128/2RGKCO7uqvMcELi4hdsq";

let scripts: Array<{ src: string; async: boolean }>;
let gtagCalls: unknown[][];

function installBrowser(opts: { doNotTrack?: string } = {}) {
  scripts = [];
  gtagCalls = [];
  (globalThis as any).navigator = { doNotTrack: opts.doNotTrack ?? null };
  (globalThis as any).document = {
    createElement: () => ({ src: "", async: false }),
    head: { appendChild: (el: any) => scripts.push(el) },
  };
  (globalThis as any).window = {};
}

// Recording gtag replaces the real queue so a test can read the arguments.
function captureGtag() {
  (globalThis as any).window.gtag = (...args: unknown[]) => gtagCalls.push(args);
}

const ads = await import("../googleAds");

describe("the ad tag stays off until it is configured", () => {
  beforeEach(() => installBrowser());

  test("loads nothing when the variable is unset", () => {
    delete process.env.VITE_GOOGLE_ADS_SEND_TO;
    ads.initGoogleAds();
    expect(scripts).toHaveLength(0);
    expect((globalThis as any).window.gtag).toBeUndefined();
  });

  test("reports nothing when the variable is unset", () => {
    delete process.env.VITE_GOOGLE_ADS_SEND_TO;
    captureGtag();
    ads.reportSignupConversion();
    expect(gtagCalls).toHaveLength(0);
  });

  test("loads nothing when the browser asks not to be tracked", () => {
    process.env.VITE_GOOGLE_ADS_SEND_TO = SEND_TO;
    installBrowser({ doNotTrack: "1" });
    ads.initGoogleAds();
    expect(scripts).toHaveLength(0);
  });
});

describe("once configured, it loads the tag and reports one conversion", () => {
  beforeEach(() => {
    installBrowser();
    process.env.VITE_GOOGLE_ADS_SEND_TO = SEND_TO;
  });

  // Calls init twice on purpose: boot can run more than once in a session, and
  // a second account tag would double every conversion. Nothing above this
  // point ever started the tag — those cases all return early — so the count
  // here is the true total.
  test("loads the account tag once, and never the conversion label", () => {
    ads.initGoogleAds();
    ads.initGoogleAds();
    expect(scripts).toHaveLength(1);
    // The label belongs in the event, never in the script URL.
    expect(scripts[0].src).toBe("https://www.googletagmanager.com/gtag/js?id=AW-11465219128");
    expect(scripts[0].async).toBe(true);
  });

  test("reports the conversion with the full send_to", () => {
    captureGtag();
    ads.reportSignupConversion();
    expect(gtagCalls).toHaveLength(1);
    expect(gtagCalls[0]).toEqual(["event", "conversion", { send_to: SEND_TO }]);
  });

  test("reports nothing when the browser asks not to be tracked", () => {
    installBrowser({ doNotTrack: "1" });
    process.env.VITE_GOOGLE_ADS_SEND_TO = SEND_TO;
    captureGtag();
    ads.reportSignupConversion();
    expect(gtagCalls).toHaveLength(0);
  });
});
