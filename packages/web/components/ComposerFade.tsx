/**
 * The fade over a scroller's cut edge, above a composer: the last visible
 * line dims into the background, so a cut mid sentence reads as more to
 * scroll rather than a truncation. It sits as the first child of the block
 * under the scroller and reaches up over the scroller's last 64px. The
 * conversation view's composer draws it, and every frame that stands in for
 * that composer (the org proposal's preview frame) draws this same one.
 */
export function ComposerFade() {
  return <div aria-hidden className="h-16 bg-gradient-to-t from-sol-bg via-[color-mix(in_srgb,var(--sol-bg)_80%,transparent)] to-transparent -mt-16 relative pointer-events-none" data-composer-fade />;
}
