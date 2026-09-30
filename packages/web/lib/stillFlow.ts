// React Flow drawn as a still picture: nothing pans, zooms, drags or selects,
// the wheel passes through to the page, and no key handler goes on the window
// or the document. The marketing hero shows the
// workflow graph and the org chart this way inside a page that must scroll.
export const STILL_FLOW_PROPS = {
  panOnDrag: false,
  panOnScroll: false,
  zoomOnScroll: false,
  zoomOnPinch: false,
  zoomOnDoubleClick: false,
  preventScrolling: false,
  nodesDraggable: false,
  nodesConnectable: false,
  elementsSelectable: false,
  deleteKeyCode: null,
  selectionKeyCode: null,
  multiSelectionKeyCode: null,
  panActivationKeyCode: null,
  zoomActivationKeyCode: null,
} as const;
