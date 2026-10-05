// The lane's look comes from the family it shares with Whisk
// (@platform/design): its token sheet, imported here, and its faces
// (Instrument Sans, Newsreader, Fragment Mono), loaded only when a lane
// surface opens: the shell and /welcome. One link, however many mount it.
import { FONTS_HREF } from "@platform/design";
import "@platform/design/tokens.css";
import { useMountEffect } from "../../hooks/useMountEffect";

export function useLaneFont(): void {
  useMountEffect(() => {
    if (document.querySelector("link[data-simple-lane-font]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONTS_HREF;
    link.dataset.simpleLaneFont = "1";
    document.head.appendChild(link);
  });
}
