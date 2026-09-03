import { PictureInPicture2 } from "lucide-react";
import { POP_OUT_PEOPLE_TITLE, isPeopleWindow } from "../../lib/desktop";
import { popOutPeople } from "./popOutPeople";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";

/**
 * Pop the buddy list out into its own window.
 *
 * Renders nothing inside the people window itself: there is no gesture to make
 * there, and a button that focuses the window you are already looking at is a
 * button that does nothing.
 *
 * Off the desktop this opens a named popup, so a second click raises the window
 * the first one opened rather than stacking another.
 */
export function PopOutPeopleButton({
  className = "",
  iconClassName = "h-3.5 w-3.5",
  onDone,
}: {
  className?: string;
  iconClassName?: string;
  /** Called once the pop-out has been asked for. The wall overlay closes
   *  itself here: the window it just opened shows the same wall, and leaving
   *  both up would be the same thing twice. */
  onDone?: () => void;
}) {
  if (isPeopleWindow()) return null;
  return (
    <ShortcutTooltip label={POP_OUT_PEOPLE_TITLE}>
      <button
        type="button"
        onClick={(e) => {
          // In the sidebar this sits inside a nav row that is itself a link.
          e.preventDefault();
          e.stopPropagation();
          void popOutPeople();
          onDone?.();
        }}
        className={className}
        aria-label={POP_OUT_PEOPLE_TITLE}
      >
        <PictureInPicture2 className={iconClassName} />
      </button>
    </ShortcutTooltip>
  );
}
