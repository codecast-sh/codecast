import { test, expect, mock, describe } from "bun:test";
// The card pill names a checkout position, never the repository: the branch,
// else the short sha of a detached head, else nothing. Two rows once read
// "codecast-sh/codecast" and "main" in the same pill, and looked alike. The
// default branch is where nearly every session sits, so a card skips it.
import { renderToStaticMarkup } from "react-dom/server";
mock.module("next/link", () => ({ default: (p: any) => <a href={p.href}>{p.children}</a> }));
mock.module("../../hooks/useWorkspaceCollection", () => ({ useWorkspaceCollection: () => [] }));
mock.module("../../hooks/useCollectionRows", () => ({ useCollectionRows: () => [] }));
mock.module("../../hooks/useSyncExternalEvents", () => ({ useSyncTaskExternalEvents() {}, useSyncPlanExternalEvents() {}, useSyncProjectExternalEvents() {} }));
const { BranchCodeLink } = await import("./RepositoryLinks");
const { commitPageHref, repoHomeHref, repoTreeHref } = await import("../../lib/repoView");
const repository = "codecast-sh/codecast";

const text = (html: string) => html.replace(/<[^>]+>/g, "");
const remote = "git@github.com:codecast-sh/codecast.git";
const sha = "0123456789abcdef0123456789abcdef01234567";

describe("BranchCodeLink on a card", () => {
  test("shows a branch off the default and links its tree", () => {
    const html = renderToStaticMarkup(<BranchCodeLink detail={false} session={{ git_remote_url: remote, git_branch: "fix-auth", git_commit_hash: sha }} />);
    expect(text(html)).toBe("fix-auth");
    expect(html).toContain(`href="${repoTreeHref(repository, "fix-auth")}"`);
  });
  test("on the default branch it stays away", () => {
    for (const branch of ["main", "master"]) {
      expect(renderToStaticMarkup(<BranchCodeLink detail={false} session={{ git_remote_url: remote, git_branch: branch, git_commit_hash: sha }} />)).toBe("");
    }
  });
  test("with no branch shows the short sha of the detached head and links the commit", () => {
    const html = renderToStaticMarkup(<BranchCodeLink detail={false} session={{ git_remote_url: remote, git_commit_hash: sha }} />);
    expect(text(html)).toBe("0123456");
    expect(html).toContain(`href="${commitPageHref(repository, sha)}"`);
    expect(html).not.toContain(">codecast-sh/codecast<");
  });
  test("with no position at all it stays away", () => {
    expect(renderToStaticMarkup(<BranchCodeLink detail={false} session={{ git_remote_url: remote }} />)).toBe("");
  });
});

describe("BranchCodeLink in the header", () => {
  test("names the default branch, since the header has room and the title says what it is", () => {
    const html = renderToStaticMarkup(<BranchCodeLink session={{ git_remote_url: remote, git_branch: "main", git_commit_hash: sha }} />);
    expect(text(html)).toBe("main0123456");
  });
  test("with no branch names the repository and links its home, with the sha beside it", () => {
    const html = renderToStaticMarkup(<BranchCodeLink session={{ git_remote_url: remote, git_commit_hash: sha }} />);
    expect(text(html)).toBe("codecast-sh/codecast0123456");
    expect(html).toContain(`href="${repoHomeHref(repository)}"`);
  });
});
