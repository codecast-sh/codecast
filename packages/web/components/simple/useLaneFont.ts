// The simple lane's typeface (Bricolage Grotesque), loaded only when a lane
// surface opens: the shell and /welcome. One link, however many mount it.
import { useMountEffect } from "../../hooks/useMountEffect";

const FONT_HREF = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&display=swap";

export function useLaneFont(): void {
  useMountEffect(() => {
    if (document.querySelector("link[data-simple-lane-font]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONT_HREF;
    link.dataset.simpleLaneFont = "1";
    document.head.appendChild(link);
  });
}
