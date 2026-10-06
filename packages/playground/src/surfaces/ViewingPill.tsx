import { Button } from "../ui/Button";
import { Keys } from "../ui/Keys";
import s from "./ViewingPill.module.css";

/** You are looking at the past, and only you (DESIGN 6.7). */
export function ViewingPill({ number, onBack }: { number: number; onBack: () => void }) {
  return (
    <div className={s.pill} role="status">
      <span className={s.text}>
        You're viewing <b className={s.v}>v{number}</b>, nobody else is
      </span>
      <Button size="sm" className={s.back} onClick={onBack}>Back to live</Button>
    </div>
  );
}

/** Point and talk is on: click anything in the app. */
export function PickBanner({ onCancel }: { onCancel: () => void }) {
  return (
    <div className={s.banner}>
      Click anything in the app
      <button className={s.cancel} onClick={onCancel}>
        <Keys keys={["Esc"]}>to cancel</Keys>
      </button>
    </div>
  );
}
