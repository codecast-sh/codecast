import type { Components } from "react-markdown";
import { MD_COMPONENTS } from "./markdownComponents";

// The reading view uses the EDITOR's type scale (editor.css), not chat's
// compact one, so toggling edit mode doesn't reflow the whole document.
// MD_COMPONENTS stays the base — entity pills, code blocks, images and the
// security plugins are shared; only the heading scale diverges.
export const DOC_MD_COMPONENTS: Components = {
  ...MD_COMPONENTS,
  h1: ({ children }) => (
    <h1 className="text-[21px] font-bold mt-10 first:mt-0 mb-3 leading-[1.3] text-sol-text">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[17px] font-semibold mt-8 mb-2 leading-[1.3] text-sol-text">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[15px] font-semibold mt-6 mb-1.5 leading-[1.4] text-sol-text">{children}</h3>
  ),
};
