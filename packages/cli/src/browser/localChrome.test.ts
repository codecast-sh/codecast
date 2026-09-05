import { describe, expect, test } from "bun:test";
import { realChromePid } from "./localChrome.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("realChromePid", () => {
  test("the human's Chrome is the browser process with neither a profile dir nor a debug port", () => {
    expect(
      realChromePid([
        { pid: 587, command: "/usr/libexec/knowledge-agent" },
        { pid: 90472, command: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/152.0.7977.77/Helpers/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler" },
        { pid: 90515, command: "/Applications/Claude.app/Contents/Helpers/chrome-native-host chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/" },
        { pid: 32558, command: "/Users/a/.cache/puppeteer/chrome/mac_arm-146/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --allow-pre-commit-input" },
        { pid: 90741, command: `${CHROME} --remote-debugging-port=58489 --user-data-dir=/Users/a/.codecast/browser/profiles/default` },
        { pid: 23879, command: `${CHROME} --remote-debugging-port=9422 --user-data-dir=/tmp/ws/chrome-profile --no-first-run` },
        { pid: 90468, command: CHROME },
      ]),
    ).toBe(90468);
  });

  test("only agent Chromes running means no real Chrome", () => {
    expect(realChromePid([{ pid: 1, command: `${CHROME} --remote-debugging-port=1 --user-data-dir=/x` }])).toBeNull();
    expect(realChromePid([])).toBeNull();
  });
});
