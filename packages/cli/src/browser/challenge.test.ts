import { describe, expect, test } from "bun:test";
import {
  awaitChallenge, CHALLENGE_PROBE_SOURCE, challengeReport, challengeWaitMs, classifyChallenge, parseChallengeProbe, type ChallengeProbe,
} from "./challenge.js";

const page = (over: Partial<ChallengeProbe> = {}): ChallengeProbe => ({
  url: "https://shop.test/item",
  title: "Item",
  text: "",
  textLength: 0,
  frameUrls: [],
  scriptSrcs: [],
  selectors: [],
  visibleSelectors: [],
  sinceLoad: 100,
  humanPhrase: null,
  ...over,
});
const short = (text: string, over: Partial<ChallengeProbe> = {}) => page({ text, textLength: text.length, ...over });

describe("classifyChallenge", () => {
  test("Cloudflare's 'Just a moment' clears itself; with the Turnstile box showing it needs a person", () => {
    expect(classifyChallenge(page({ title: "Just a moment..." }))).toMatchObject({ vendor: "cloudflare", kind: "clears-itself" });
    expect(
      classifyChallenge(page({ title: "Just a moment...", selectors: [".cf-turnstile"], visibleSelectors: [".cf-turnstile"] })),
    ).toMatchObject({ vendor: "cloudflare", kind: "needs-person" });
    expect(classifyChallenge(short("Verify you are human by completing the action below.", { selectors: ["#challenge-form"] })))
      .toMatchObject({ vendor: "cloudflare", kind: "needs-person" });
  });

  test("Cloudflare's block page stops", () => {
    expect(classifyChallenge(short("Sorry, you have been blocked. Cloudflare Ray ID: 1"))).toMatchObject({ vendor: "cloudflare", kind: "blocked" });
  });

  test("a Turnstile widget embedded in a form is part of the page, solved or not", () => {
    // Its iframe stays after it solves, so treating it as an interstitial
    // would wait 15 s and fail a login page that works.
    const frame = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2";
    const login = short("Sign in\nEmail\nPassword\nSign in", { title: "Sign in", frameUrls: [frame], selectors: [".cf-turnstile"], visibleSelectors: [".cf-turnstile"] });
    expect(classifyChallenge(login)).toBeNull();
    expect(classifyChallenge(page({ frameUrls: [frame], textLength: 20_000, text: "long article" }))).toBeNull();
  });

  test("Cloudflare's challenge ids count on a short page or beside its challenge script, not on a long page alone", () => {
    expect(classifyChallenge(page({ selectors: ["#challenge-form"], textLength: 9_000, text: "a coding challenge site" }))).toBeNull();
    expect(
      classifyChallenge(page({ selectors: ["#challenge-form"], textLength: 9_000, scriptSrcs: ["https://shop.test/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"] }))?.vendor,
    ).toBe("cloudflare");
  });

  test("PerimeterX: its captcha element, or Press & Hold on a short page that loads PerimeterX", () => {
    expect(classifyChallenge(short("Press & Hold", { selectors: ["#px-captcha"] }))).toMatchObject({ vendor: "perimeterx", kind: "needs-person" });
    expect(
      classifyChallenge(short("Press & Hold to confirm you are a human", { scriptSrcs: ["https://client.px-cloud.net/PXabc123/main.min.js"] })),
    ).toMatchObject({ vendor: "perimeterx", kind: "needs-person" });
  });

  test("'press and hold' in ordinary help text is not PerimeterX", () => {
    // An Apple support page: "press and hold the side button".
    expect(classifyChallenge(short("To turn off your iPhone, press and hold the side button and either volume button."))).toBeNull();
    expect(classifyChallenge(page({ title: "Force restart iPhone - Apple Support", text: "Press and hold the side button", textLength: 6_000 }))).toBeNull();
  });

  test("DataDome: the interstitial clears itself, the captcha needs a person", () => {
    expect(classifyChallenge(page({ frameUrls: ["https://geo.captcha-delivery.com/interstitial/?x=1"] }))?.kind).toBe("clears-itself");
    expect(classifyChallenge(page({ frameUrls: ["https://geo.captcha-delivery.com/captcha/?x=1"] }))?.kind).toBe("needs-person");
  });

  test("Akamai: silent challenge, and the Access Denied reference page", () => {
    expect(classifyChallenge(page({ selectors: ["#sec-if-cpt-container"] }))).toMatchObject({ vendor: "akamai", kind: "clears-itself" });
    expect(
      classifyChallenge(short("You don't have permission to access this resource. Reference #18.abc", { title: "Access Denied" })),
    ).toMatchObject({ vendor: "akamai", kind: "blocked" });
  });

  test("Imperva: incident page blocks, resource with captcha needs a person", () => {
    expect(classifyChallenge(short("Request unsuccessful. Incapsula incident ID: 1", { scriptSrcs: ["https://x.test/_Incapsula_Resource?a"] })))
      .toMatchObject({ vendor: "imperva", kind: "blocked" });
    expect(classifyChallenge(short("please complete the captcha", { frameUrls: ["https://x.test/_Incapsula_Resource?b"] })))
      .toMatchObject({ vendor: "imperva", kind: "needs-person" });
  });

  test("AWS WAF captcha and silent challenge", () => {
    expect(classifyChallenge(page({ selectors: ["awswaf-captcha"] }))).toMatchObject({ vendor: "aws-waf", kind: "needs-person" });
    expect(classifyChallenge(short("", { scriptSrcs: ["https://abc.token.awswaf.com/x/challenge.js"] })))
      .toMatchObject({ vendor: "aws-waf", kind: "clears-itself" });
  });

  test("Amazon's robot check, over a full storefront or on its own page", () => {
    const storefront = { text: "Deliver to Brooklyn 11215 All Departments", textLength: 40_000 };
    expect(classifyChallenge(page({ ...storefront, url: "https://www.amazon.com/checkpoint/continue?token=x", humanPhrase: "I am human" })))
      .toMatchObject({ vendor: "amazon", kind: "needs-person" });
    expect(classifyChallenge(page({ url: "https://www.amazon.co.uk/errors/validateCaptcha" })))
      .toMatchObject({ vendor: "amazon", kind: "needs-person" });
    // The same phrase elsewhere, or an ordinary Amazon page, is not a check.
    expect(classifyChallenge(page({ ...storefront, url: "https://blog.test/post", humanPhrase: "I am human" }))).toBeNull();
    expect(classifyChallenge(page({ ...storefront, url: "https://www.amazon.com/cart" }))).toBeNull();
    expect(classifyChallenge(page({ url: "https://notamazon.com/x", humanPhrase: "I am human" }))).toBeNull();
  });

  test("captcha walls and Google's sorry page", () => {
    expect(classifyChallenge(short("Please complete the captcha", { frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=1"] })))
      .toMatchObject({ vendor: "recaptcha", kind: "needs-person" });
    expect(classifyChallenge(short("captcha", { frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/x"] })))
      .toMatchObject({ vendor: "hcaptcha", kind: "needs-person" });
    expect(classifyChallenge(short("unusual traffic", { url: "https://www.google.com/sorry/index?continue=x" })))
      .toMatchObject({ vendor: "recaptcha", kind: "needs-person" });
  });

  test("generic phrases count only on short pages", () => {
    expect(classifyChallenge(short("Access denied", { title: "403 Forbidden" }))).toMatchObject({ vendor: "generic", kind: "blocked" });
    expect(classifyChallenge(short("Pardon our interruption..."))).toMatchObject({ vendor: "generic", kind: "needs-person" });
    const article = "x".repeat(5000);
    expect(classifyChallenge(page({ title: "Access Denied", text: `access denied ${article}`, textLength: 5014 }))).toBeNull();
  });

  test("an ordinary page and a non-http page are not challenges", () => {
    expect(classifyChallenge(short("Welcome to the shop"))).toBeNull();
    expect(classifyChallenge(short("Just a moment", { url: "about:blank", title: "Just a moment..." }))).toBeNull();
  });
});

describe("awaitChallenge", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  test("waits out a challenge that clears itself", async () => {
    const c = clock();
    const probes = [page({ title: "Just a moment..." }), page({ title: "Just a moment..." }), page({ title: "Shop" })];
    const out = await awaitChallenge(probes[0], { ...c, probe: async () => probes.shift()! }, 15_000);
    expect(out).toMatchObject({ cleared: true, vendor: "cloudflare" });
    expect(out!.waitedMs).toBeGreaterThan(0);
  });

  test("gives up after the bound, still blocked, and asks for a person", async () => {
    const c = clock();
    const cf = page({ title: "Just a moment..." });
    const out = await awaitChallenge(cf, { ...c, probe: async () => cf }, 15_000);
    expect(out).toMatchObject({ cleared: false, kind: "clears-itself" });
    expect(out!.waitedMs).toBe(15_000);
    expect(challengeReport(out!)).toMatch(/needs a person.*still there after 15 s.*Hand it to the human/);
  });

  test("a challenge that needs a person is reported at once, without waiting or touching it", async () => {
    let probed = 0;
    const px = short("Press & Hold", { selectors: ["#px-captcha"] });
    const out = await awaitChallenge(px, { ...clock(), probe: async () => (probed++, px) }, 15_000);
    expect(probed).toBe(0);
    expect(out).toMatchObject({ cleared: false, kind: "needs-person", waitedMs: 0 });
  });

  test("a block is reported with an instruction to stop", async () => {
    const out = await awaitChallenge(short("Sorry, you have been blocked. cloudflare"), { ...clock(), probe: async () => null }, 15_000);
    expect(challengeReport(out!)).toMatch(/refused the visit.*Stop here. Do not retry or reload/);
  });

  test("an ordinary page returns null", async () => {
    expect(await awaitChallenge(page(), { ...clock(), probe: async () => null }, 15_000)).toBeNull();
  });
});

describe("the probe", () => {
  test("reads a page-like DOM and parses back", () => {
    const el = { getBoundingClientRect: () => ({ width: 10, height: 10 }) };
    const document: any = {
      body: { innerText: "Just a moment" },
      title: "Just a moment...",
      querySelector: (s: string) => (s === "#challenge-form" ? el : null),
      querySelectorAll: () => [{ src: "https://challenges.cloudflare.com/x" }],
      scripts: [{ src: "" }, { src: "https://a.test/s.js" }],
    };
    const run = new Function("document", "location", "performance", `return ${CHALLENGE_PROBE_SOURCE}`);
    const p = parseChallengeProbe(JSON.stringify(run(document, { href: "https://a.test/" }, { now: () => 42 })));
    expect(p).toMatchObject({
      url: "https://a.test/",
      selectors: ["#challenge-form"],
      visibleSelectors: ["#challenge-form"],
      scriptSrcs: ["https://a.test/s.js"],
      sinceLoad: 42,
      humanPhrase: null,
    });
    expect(classifyChallenge(p!)?.vendor).toBe("cloudflare");
  });

  test("finds the robot-check phrase past the text it keeps", () => {
    const document: any = {
      body: { innerText: `${"x".repeat(5000)} Click the box: I am human. Continue shopping` },
      title: "Amazon.com",
      querySelector: () => null,
      querySelectorAll: () => [],
      scripts: [],
    };
    const run = new Function("document", "location", "performance", `return ${CHALLENGE_PROBE_SOURCE}`);
    const p = parseChallengeProbe(JSON.stringify(run(document, { href: "https://www.amazon.com/cart" }, { now: () => 1 })));
    expect(p?.humanPhrase).toBe("I am human");
    expect(classifyChallenge(p!)).toMatchObject({ vendor: "amazon", kind: "needs-person" });
  });

  test("wait bound reads the env, within 0 to 60 s", () => {
    expect(challengeWaitMs({})).toBe(15_000);
    expect(challengeWaitMs({ CAST_BROWSER_CHALLENGE_WAIT_MS: "0" })).toBe(0);
    expect(challengeWaitMs({ CAST_BROWSER_CHALLENGE_WAIT_MS: "999999" })).toBe(15_000);
  });
});
