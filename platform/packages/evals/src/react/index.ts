'use client';
/**
 * @platform/evals/react: EvalsProvider, the hooks, views and pages, rendered
 * against the host's router and primitives. Hosts import `styles.css` and
 * `tokens.css` once at their mount root; no component imports CSS.
 */
export { EvalsProvider, type EvalsProviderProps } from './EvalsProvider';
export { EvalsApp } from './EvalsApp';
export { defaultEvalsHost, resolveEvalsHost } from './defaults';
export * from './host';
export * from './hooks';
export * from './shell';
export * from './run';
export * from './surface';
export * from './freeze';
export * from './bisect';
