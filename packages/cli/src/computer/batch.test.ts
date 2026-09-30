import { describe, expect, test } from "bun:test";
import { parseStepFlags, planStep, type ComputerBatchContext } from "./batch.js";
import { tokenize } from "../stepBatch.js";

const plan = (ctx: ComputerBatchContext, step: string) => planStep(ctx, tokenize(step));
const fresh = (): ComputerBatchContext => ({ defaults: { app: "com.apple.Preview", windowId: "42823" } });

describe("a do step becomes the options the single command would have run", () => {
  test("the batch's app and window are every step's default, and a step can override them", () => {
    expect(plan(fresh(), 'click "Sign"').options).toMatchObject({ app: "com.apple.Preview", windowId: "42823", element: "Sign" });
    expect(plan(fresh(), "press Return --app com.apple.TextEdit").options).toMatchObject({ app: "com.apple.TextEdit", key: "Return" });
  });

  test("the shortcuts map onto the verbs", () => {
    expect(plan(fresh(), 'action "insert signature" "Created January"')).toEqual({
      verb: "perform-secondary-action",
      options: expect.objectContaining({ action: "insert signature", element: "Created January" }),
    });
    expect(plan(fresh(), 'set "Search" "invoice"').options).toMatchObject({ element: "Search", value: "invoice" });
    expect(plan(fresh(), 'scroll down "Messages"').options).toMatchObject({ direction: "down", element: "Messages" });
    expect(plan(fresh(), 'type "hello world"')).toMatchObject({ verb: "type-text", options: { text: "hello world" } });
    expect(plan(fresh(), 'wait "Created" --gone --timeout 3')).toMatchObject({ verb: "wait", options: { text: "Created", gone: true, timeout: "3" } });
  });

  test("drag ends are names, indexes or window points", () => {
    expect(plan(fresh(), "drag 472,655 233,128").options).toMatchObject({ x: "472", y: "655", toX: "233", toY: "128" });
    expect(plan(fresh(), 'drag #12 "Trash"').options).toMatchObject({ element: "#12", toElement: "Trash" });
  });

  test("a snapshot in a batch reads the tree without a capture; shot is for pictures", () => {
    expect(plan(fresh(), "snapshot").options.screenshot).toBe(false);
    expect(plan(fresh(), "snapshot --screenshot").options.screenshot).toBe(true);
    expect(plan(fresh(), "shot")).toMatchObject({ verb: "shot", options: { screenshot: true } });
  });

  test("a bare click or action acts on what the last find named", () => {
    const ctx = fresh();
    plan(ctx, 'find "button Sign"');
    expect(plan(ctx, "click").options.element).toBe("button Sign");
    expect(plan(ctx, "click #3").options.element).toBe("#3");
    expect(plan(ctx, "click --x 1 --y 2").options.element).toBeUndefined();
  });

  test("an unknown step names the ones that exist", () => {
    expect(() => plan(fresh(), "tap Sign")).toThrow("unknown step 'tap'");
  });
});

describe("parseStepFlags", () => {
  test("value flags take the next token, switches do not, and --no- negates", () => {
    expect(parseStepFlags(["--element-index", "5", "--mouse", "--no-screenshot", "extra"])).toEqual({
      options: { elementIndex: "5", mouse: true, screenshot: false },
      positional: ["extra"],
    });
    expect(() => parseStepFlags(["--nth"])).toThrow("--nth needs a value");
  });
});
