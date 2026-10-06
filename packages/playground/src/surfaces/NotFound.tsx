import { Blob } from "../ui/Blob";
import { MakerBar } from "./Home";
import s from "./NotFound.module.css";

/** A link that leads nowhere: say so, and offer to make something here. */
export function NotFound() {
  return (
    <div className={s.page}>
      <Blob size={120} down />
      <h1 className={s.title}>No app lives here</h1>
      <p className={s.sub}>Want to make one?</p>
      <div className={s.maker}>
        <MakerBar />
      </div>
    </div>
  );
}
