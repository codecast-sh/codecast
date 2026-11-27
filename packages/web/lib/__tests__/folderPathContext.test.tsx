import { describe, expect, test } from "bun:test";
import { useContext } from "react";
import { renderToString } from "react-dom/server";
import { FilePathContext, useFolderPathContext } from "../filePathLinks";

// A task or plan with a project folder resolves relative paths there; one
// without keeps whatever context it is drawn inside (a conversation's).

function Probe() {
  return <i>{useContext(FilePathContext)?.base ?? "none"}</i>;
}

function Thread({ folder }: { folder?: string }) {
  const ctx = useFolderPathContext(folder);
  return (
    <FilePathContext.Provider value={ctx}>
      <Probe />
    </FilePathContext.Provider>
  );
}

const inConversation = (folder?: string) =>
  renderToString(
    <FilePathContext.Provider value={{ base: "/src/conv", home: "/Users/ada" }}>
      <Thread folder={folder} />
    </FilePathContext.Provider>,
  );

describe("useFolderPathContext", () => {
  test("the row's project wins", () => expect(inConversation("/src/task")).toContain("/src/task"));
  test("no project keeps the conversation's", () => expect(inConversation()).toContain("/src/conv"));
  test("no project and nothing around it resolves nothing", () => expect(renderToString(<Thread />)).toContain("none"));
});
