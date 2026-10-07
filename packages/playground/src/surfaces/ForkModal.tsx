// "Fork v12" (DESIGN 6.8): name it, and land in the new app's own room.
// The copy is v12's code with today's data, and a version someone already
// forked says where that fork lives, so you can join it instead.
import { useState } from "react";
import type { ForkOf } from "../../convex/versions";
import { APP_NAME_MAX } from "../../convex/lib/slugs";
import { api } from "../../convex/_generated/api";
import { errorData } from "../lib/errors";
import { forkName } from "../lib/format";
import { useIdentity, useVisitorMutation } from "../lib/identity";
import { appUrl, navigate, roomUrl } from "../lib/router";
import { nameFor } from "../lib/versionCopy";
import { Button } from "../ui/Button";
import { Link } from "../ui/Link";
import { Modal } from "../ui/Modal";
import { useAppState } from "./appState";
import s from "./ForkModal.module.css";

export function ForkModal({ from, onClose }: { from: number; onClose: () => void }) {
  const { app, versionByNumber } = useAppState();
  const { me } = useIdentity();
  const forks = versionByNumber.get(from)?.forks ?? [];
  const fork = useVisitorMutation(api.apps.fork);
  const [name, setName] = useState(() => forkName(app.name, me.name, APP_NAME_MAX));
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
      setError(errorData(err).message);
    }
  };

  return (
    <Modal onClose={onClose} label={`Fork v${from}`} className={s.modal}>
      <form className={s.body} onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}>
        <h2 className={s.title}>Fork v{from}</h2>
        <p className={s.lede}>A new app with v{from}'s code and a copy of today's data. Its own room, its own link.</p>
        {forks.length > 0 && (
          <p className={s.already}>
            <ForkedInto forks={forks} />. Join it, or make your own.
          </p>
        )}
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
          <Button type="button" size="md" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="ink" size="md" busy={busy} disabled={!name.trim()}>Fork it</Button>
        </div>
      </form>
    </Modal>
  );
}

/** "Iris forked this into Tally, take two", the newest fork named and linked,
 *  with how many more there are. */
export function ForkedInto({ forks }: { forks: ForkOf[] }) {
  const { me } = useIdentity();
  const latest = forks.at(-1);
  if (!latest) return null;
  return (
    <span>
      {nameFor(latest.by, me.id)} forked this into <Link to={appUrl(latest.slug)}>{latest.name}</Link>
      {forks.length > 1 && `, and ${forks.length - 1} more`}
    </span>
  );
}
