import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { MemoryRouter } from "react-router";
import { ResourcePressureFallback, ResourcePressureGauge } from "./ResourcePressureGauge";

test("the header keeps a Resources control before any machine readings arrive", () => {
  const client = new ConvexReactClient("https://fixture.convex.cloud");
  const html = renderToStaticMarkup(<ConvexProvider client={client}><MemoryRouter><ResourcePressureGauge /></MemoryRouter></ConvexProvider>);
  void client.close();
  expect(html).toContain('aria-label="Resources — live readings unavailable"');
  expect(html).toContain("<svg");
  expect(html).not.toContain("rotate(");
});

test("a failed readings component has the same usable Resources fallback", () => {
  const html = renderToStaticMarkup(<MemoryRouter><ResourcePressureFallback /></MemoryRouter>);
  expect(html).toContain('type="button"');
  expect(html).toContain("Resources — live readings unavailable");
});
