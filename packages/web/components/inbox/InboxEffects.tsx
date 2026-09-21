import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useShortcutContext } from "../../shortcuts";

export function OrgTreeFeeder() {
  useSyncOrgTreeFeeder();
  return null;
}

export function InboxShortcuts() {
  useShortcutContext("inbox");
  return null;
}
