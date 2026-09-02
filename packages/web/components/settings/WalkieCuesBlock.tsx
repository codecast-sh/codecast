// The block that plays the six walkie cues, shared by the Sounds settings page
// and the call settings panel.
import { Button } from "../ui/button";
import { previewWalkieCue, WALKIE_PREVIEWS } from "../../lib/sounds";

/** The six walkie cues, each with a button that plays it.
 *
 *  Every other sound in the app answers something a person did or something
 *  that arrived, so nobody ever hears one on purpose and nobody can say
 *  whether it is right. These cues had been four times too quiet for months
 *  before the founder put it in words. This block is where they can be heard
 *  on demand, which is the only way that stays checkable. */
export function WalkieCuesBlock() {
  return (
    <div className="px-4 py-3.5 sm:px-5">
      <div className="text-sm text-sol-text">The six cues</div>
      <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-sol-text-muted">
        Live and Roger are your own key going down and coming up, Incoming and Ended are a
        teammate&apos;s burst, Joined is someone stepping into yours, Away means nobody was live
        and it went as a message.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {WALKIE_PREVIEWS.map((cue) => (
          <Button key={cue.id} variant="outline" size="sm" onClick={() => previewWalkieCue(cue.spec)}>
            {cue.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
