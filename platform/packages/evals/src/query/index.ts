/**
 * @platform/evals/query: createEvalsHandler, the one handler that answers the
 * neutral routes from a product's sources, and the row view builders. Pure:
 * it may read ./contract and ./analysis, never node, React or the DOM.
 */
export * from './request';
export * from './sources';
export { evalsViews, ledgerOf, rowsMemo, type SurfaceFilter } from './views';
export * from './handler';
