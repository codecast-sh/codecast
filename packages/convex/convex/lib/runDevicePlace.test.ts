import { describe, expect, test } from "bun:test";
import { placeRunOnDevice } from "./runDevicePlace";

const NOW = 1_800_000_000_000;
const laptop = { device_id: "laptop", label: "jb-m5-max", last_seen: NOW - 5_000, git_plane: [{ root: "/Users/me/code/codecast", origin: "git@github.com:codecast-sh/codecast.git" }] };
const box = {
  device_id: "box", label: "Union AWS 128GB", last_seen: NOW - 10_000,
  git_plane: [{ root: "/home/me/code/union-mobile", origin: "https://github.com/union/union-mobile" }, { root: "/home/me/scratch/codecast", origin: "https://github.com/codecast-sh/codecast.git" }],
  line_slots: [{ root: "/home/me/code/codecast/", origin: "github.com/codecast-sh/codecast" }],
};
const asked = { devices: [laptop, box], asker: "laptop", project_path: "/Users/me/code/codecast", origin: "git@github.com:codecast-sh/codecast.git", now: NOW };

describe("placeRunOnDevice", () => {
  test("another machine takes its own checkout of the same origin, its line slot first", () => {
    expect(placeRunOnDevice({ ...asked, target: "box" })).toMatchObject({ device: "box", project_path: "/home/me/code/codecast" });
  });

  test("its git plane answers when it offers no line slot for the origin", () => {
    const plain = { ...box, line_slots: [] };
    expect(placeRunOnDevice({ ...asked, devices: [laptop, plain], target: "box" })).toMatchObject({ device: "box", project_path: "/home/me/scratch/codecast" });
  });

  test("the asking machine keeps the folder it was asked from", () => {
    expect(placeRunOnDevice({ ...asked, target: "laptop" })).toMatchObject({ device: "laptop", project_path: "/Users/me/code/codecast" });
  });

  test("a machine that is not the caller's is refused", () => {
    expect(placeRunOnDevice({ ...asked, target: "teammate" })).toEqual({ refusal: expect.stringContaining("not one of your machines") });
  });

  test("an offline machine is refused, never swapped", () => {
    const off = { ...box, last_seen: NOW - 10 * 60_000 };
    expect(placeRunOnDevice({ ...asked, devices: [laptop, off], target: "box" })).toEqual({ refusal: expect.stringContaining("Union AWS 128GB is offline") });
  });

  test("a machine with no checkout of the origin is refused with the origin named", () => {
    expect(placeRunOnDevice({ ...asked, origin: "git@github.com:someone/else.git", target: "box" })).toEqual({ refusal: expect.stringContaining("no checkout of github.com/someone/else") });
  });

  test("a folder with no origin is refused", () => {
    expect(placeRunOnDevice({ ...asked, origin: null, target: "box" })).toEqual({ refusal: expect.stringContaining("names no git origin") });
  });
});
