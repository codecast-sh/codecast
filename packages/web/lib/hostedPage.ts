// The one frame hosted mode's pages sit in (Inbox's lists, To-dos, Notes,
// Approvals, Routines and a routine's page): the same measure, the same inner
// edge and the same top, so moving between them with Cmd+1 to Cmd+5 never
// moves the title.
export const HOSTED_PAGE_FRAME = "mx-auto w-full max-w-3xl";
export const HOSTED_PAGE_PAD = "px-4 sm:px-6";
/** Where a page's title row starts: 24px under the top bar. */
export const HOSTED_PAGE_TOP = "pt-6";
/** The same top for a list page (To-dos, Notes), whose header row carries
 *  6px of padding of its own (.cc-panel__head--flow). */
export const HOSTED_LIST_TOP = "pt-[18px]";
