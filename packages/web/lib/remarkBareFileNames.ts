// A bare file name in an agent's reply ("copied from the edited
// constitution.md") becomes a candidate link. The parse cannot know whether
// the session changed that file (the render cache is keyed by text alone), so
// the node carries the name in BARE_FILE_ATTR and EntityAwareLink decides with
// the conversation's FilePathContext: a file the session changed opens in
// Files, anything else renders as the words it was written as.

import { findAndReplace } from "mdast-util-find-and-replace";
import { BARE_FILE_NAME_SCAN_RE } from "./filePathLinks";

export const BARE_FILE_ATTR = "data-bare-file";

export function remarkBareFileNames() {
  return (tree: any) => {
    findAndReplace(
      tree,
      [
        [
          BARE_FILE_NAME_SCAN_RE,
          (_full: string, name: string) => ({
            type: "link",
            url: "",
            children: [{ type: "text", value: name }],
            data: { hProperties: { [BARE_FILE_ATTR]: name } },
          }),
        ],
      ],
      { ignore: ["link", "inlineCode", "code"] },
    );
  };
}
