// Changes Clay suggests for this app (app.ideas, written with each version
// it builds). A tap puts one in the composer as a change, unsent, so the
// visitor can make it their own.
import { Chip } from "../ui/Chips";
import { useAppState, useComposer } from "./appState";

/** Until Clay has written ideas for this app. */
const STARTER_IDEAS = ["make it dark", "add a sound when someone clicks", "add a scoreboard"];

export function IdeaChips({ max = 3, className }: { max?: number; className?: string }) {
  const { app } = useAppState();
  const composer = useComposer();
  const ideas = (app.ideas.length ? app.ideas : STARTER_IDEAS).slice(0, max);
  return (
    <div className={className}>
      {ideas.map((idea) => (
        <Chip
          key={idea}
          onClick={() => {
            composer.setMode("change");
            composer.setText(idea);
            composer.focus();
          }}
        >
          {idea}
        </Chip>
      ))}
    </div>
  );
}
