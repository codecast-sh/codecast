import { toast } from "sonner";
import { ORG_MEET_TOAST_ID } from "./orgIntroCard";
import { OrgIntroCard } from "../components/org/OrgIntroCard";

/** Raise the card on the app's toast. `onAnswer` runs once whichever way it
 *  closes, including a swipe, and `onSee` when the person asks to see it. */
export function showOrgIntroCard({ onSee, onAnswer }: { onSee: () => void; onAnswer: () => void }) {
  let answered = false;
  const answer = () => { if (answered) return; answered = true; onAnswer(); };
  toast.custom(
    (id) => (
      <OrgIntroCard
        onSee={() => { answer(); toast.dismiss(id); onSee(); }}
        onDismiss={() => { answer(); toast.dismiss(id); }}
      />
    ),
    { id: ORG_MEET_TOAST_ID, duration: Infinity, onDismiss: answer },
  );
}
