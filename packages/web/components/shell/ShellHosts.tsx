import { lazy, Suspense } from "react";
import { AppAddressBarHost } from "../AppAddressBar";
import { useRouter } from "next/navigation";
import { ErrorBoundary } from "../ErrorBoundary";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useCallsAvailable, useTeamFeature } from "../../lib/teamFeatures";
import { useInboxStore, type CreateModalKind } from "../../store/inboxStore";
import { teamMembersOf } from "../../lib/activeTeam";

const CommandPalette = lazy(() =>
  import("../CommandPalette").then((module) => ({ default: module.CommandPalette })),
);
const PeopleWallModal = lazy(() =>
  import("../people/PeopleWallModal").then((module) => ({ default: module.PeopleWallModal })),
);
const CreateTaskModal = lazy(() =>
  import("../CreateTaskModal").then((module) => ({ default: module.CreateTaskModal })),
);
const CreateDocModal = lazy(() =>
  import("../CreateDocModal").then((module) => ({ default: module.CreateDocModal })),
);
const CreateChannelModal = lazy(() =>
  import("../CreateChannelModal").then((module) => ({ default: module.CreateChannelModal })),
);
const NewMessageModal = lazy(() =>
  import("../chat/NewMessageModal").then((module) => ({ default: module.NewMessageModal })),
);

// The create dialogs (New → Task, Doc, Plan, Channel, Huddle; the palette's
// Create group; the board's "+"). One host for the window, mounted at every
// width: it used to live inside the desktop Sidebar, which a phone does not
// mount, so every create there did nothing. It reads the roster and the rest
// only while a dialog is open.
export function CreateModalHost() {
  const kind = useInboxStore((s) => s.createModal);
  if (!kind) return null;
  return (
    // A crash costs the dialog, not the shell; the fallback closes it so the
    // next open starts clean.
    <ErrorBoundary name="Create dialog" fallback={<CloseCreateModalOnCrash />}>
      <CreateModal kind={kind} />
    </ErrorBoundary>
  );
}

function CloseCreateModalOnCrash() {
  useMountEffect(() => useInboxStore.getState().closeCreateModal());
  return null;
}

function CreateModal({ kind }: { kind: CreateModalKind }) {
  const router = useRouter();
  const { user: currentUser } = useCurrentUser();
  const teamMembers = useInboxStore(teamMembersOf);
  const defaults = useInboxStore((s) => s.createModalDefaults);
  const closeCreateModal = useInboxStore((s) => s.closeCreateModal);
  // Per-team opt-ins: no channel dialog without chat, no huddle without calls.
  const chatOn = useTeamFeature("chat");
  const callsOn = useCallsAvailable();
  const close = () => closeCreateModal();
  return (
    <Suspense fallback={null}>
      {kind === "task" && (
        <CreateTaskModal onClose={close} teamMembers={teamMembers ?? []} currentUser={currentUser} defaults={defaults} />
      )}
      {kind === "doc" && <CreateDocModal onClose={close} initialType="note" />}
      {kind === "plan" && <CreateDocModal onClose={close} initialType="plan" />}
      {kind === "chat" && chatOn && (
        <CreateChannelModal
          onClose={close}
          // The stub id is what the rail already shows; the tab path follows the
          // supersede when the server row lands (rekeyId).
          onCreated={(channelId) => router.push(`/chat/${channelId}`)}
        />
      )}
      {/* "New huddle" is the new-message field with a huddle intent: the
          same people/rooms search, ending in a ring instead of a room. */}
      {kind === "huddle" && callsOn && <NewMessageModal intent="huddle" onClose={close} />}
    </Suspense>
  );
}

// The palette and the people wall each mount only while open. Their open
// flags live in these leaves, so opening one re-renders the leaf, not the shell.
// The address bar is the palette's sibling overlay and rides the same host.
export function PaletteHost() {
  const open = useInboxStore((s) => s.palette.open);
  return (
    <>
      {open && (
        <ErrorBoundary name="CommandPalette" level="inline">
          <Suspense fallback={null}><CommandPalette /></Suspense>
        </ErrorBoundary>
      )}
      <ErrorBoundary name="AppAddressBar" level="inline">
        <AppAddressBarHost />
      </ErrorBoundary>
    </>
  );
}

// The wall of faces, over the main window. Mounted here rather than on a
// route because it is a gesture, not a place: you open it, hold somebody,
// and it goes away. It renders nothing and subscribes to nothing while shut.
export function PeopleWallHost() {
  const open = useInboxStore((s) => s.peopleWallOpen);
  if (!open) return null;
  return (
    <ErrorBoundary name="PeopleWallModal" level="panel">
      <Suspense fallback={null}><PeopleWallModal /></Suspense>
    </ErrorBoundary>
  );
}
