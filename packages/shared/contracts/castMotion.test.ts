import { expect, test } from "bun:test";
import { pageHasHyperframesRuntime, pageIsMotion } from "./castMotion";

test("a composition root with its canvas size is a motion page", () => {
  expect(pageIsMotion(`<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="5"></div>`)).toBe(true);
  expect(pageIsMotion(`<main\n  data-width="1080"\n  data-composition-id='intro'\n  data-height="1920">`)).toBe(true);
});

test("ordinary pages, size-less ids and sub-composition hosts are not", () => {
  expect(pageIsMotion(`<html><body><h1>Report</h1><video controls src="a.mp4"></video></body></html>`)).toBe(false);
  expect(pageIsMotion(`<div data-composition-id="main"></div>`)).toBe(false);
  expect(pageIsMotion(`<div data-composition-id="intro" data-composition-src="intro.html" data-width="1920" data-height="1080"></div>`)).toBe(false);
  expect(pageIsMotion(`<template data-composition-id="x" data-width="1" data-height="1"></template>`)).toBe(false);
  expect(pageIsMotion(`<p>write data-composition-id="main" data-width="1920" data-height="1080" on the root</p>`)).toBe(false);
});

test("a page that ships its own runtime is recognized", () => {
  expect(pageHasHyperframesRuntime(`<script src="https://cdn.jsdelivr.net/npm/@hyperframes/core@0.8.1/dist/hyperframe.runtime.iife.js"></script>`)).toBe(true);
  expect(pageHasHyperframesRuntime(`<script src="gsap.min.js"></script>`)).toBe(false);
});
