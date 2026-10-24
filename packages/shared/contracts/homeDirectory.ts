// A machine user's home directory itself: /root, /Users/<name>, /home/<name>.
// A session recorded there ran in its person's home with no repository, so on
// another machine the equivalent place is that machine's home, and it is
// never a project the pickers should list.
//
// PURE isomorphic data — no Node or DOM APIs.

export function isHomeDirectoryPath(p: string | null | undefined): boolean {
  const segs = (p ?? "").split("/").filter(Boolean);
  if (!(p ?? "").startsWith("/")) return false;
  if (segs.length === 1) return segs[0] === "root";
  return segs.length === 2 && (segs[0] === "Users" || segs[0] === "home");
}
