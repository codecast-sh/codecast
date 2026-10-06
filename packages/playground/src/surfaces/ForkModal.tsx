// "Fork v12" (DESIGN 6.8): name it, and land in the new app's own room.
import { useState } from "react";
import { APP_NAME_MAX } from "../../convex/lib/slugs";
import { forkApp } from "../data/timelineApi";
import { errorData } from "../lib/errors";
import { useIdentity, useVisitorMutation } from "../lib/identity";
import { navigate, roomUrl } from "../lib/router";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useAppState } from "./appState";
import s from "./ForkModal.module.css";

export function ForkModal({ from, onClose }: { from: number; onClose: () => void }) {
  const { app } = useAppState();
  const { me } = useIdentity();
  const fork = useVisitorMutation(forkApp);
  const [name, setName] = useState(() => `${app.name}, ${me.name}'s take`.slice(0, APP_NAME_MAX));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await fork({ app_id: app.id, number: from, name: name.trim() });
      onClose();
      navigate(roomUrl(made.slug));
    } catch (err) {
      setBusy(false);
      setError(String(err).includes("Could not find public function") ? "Forking is almost ready. Try again soon." : errorData(err).message);
    }
  };

  return (
    <Modal onClose={onClose} label={`Fork v${from}`} className={s.modal}>
      <form className={s.body} onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}>
        <h2 className={s.title}>Fork v{from}</h2>
        <p className={s.lede}>A new app with v{from}'s code and a copy of its data. Its own room, its own link.</p>
        <label className={s.label}>
          <span className="sr-only">Name</span>
          <input
            data-autofocus
            className={s.input}
            value={name}
            maxLength={APP_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        {error && <p className={s.error}>{error}</p>}
        <div className={s.actions}>
          <Button type="submit" variant="fork" busy={busy} disabled={!name.trim()}>Fork it</Button>
          <Button type="button" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}
