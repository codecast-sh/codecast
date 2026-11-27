// Preview entry: the real PriorityChangeCard over its synthetic fixture
// (components/decisions/__fixtures__/priorityCard.fixture.ts), for eyeballing
// and screenshotting without a backend. `?theme=light` flips the theme
// (default dark), `?view=answered|correction|none` shows each answered record, `?width=402`, `?long=1`, `?ticked=none`
// frames it at a phone's width.
import "../app/globals.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PriorityChangeCard, type PriorityCardAnswer, type PriorityCardAnswered } from "../components/decisions/PriorityChangeCard";
import { fixtureTickedSome, priorityCardFixture } from "../components/decisions/__fixtures__/priorityCard.fixture";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.add(params.get("theme") === "light" ? "light" : "dark", "modern-style");
const view = params.get("view");
// `?long=1`: an unbroken token in the headline, the case and a priority's title, to check nothing widens the page.
const LONG = "https://status.example.com/load-tests/holiday-rush-2026/checkout-under-flaky-network-conditions-run-7";
const long = params.get("long") === "1";
const card = long ? { ...priorityCardFixture, groups: priorityCardFixture.groups.map((g, i) => (i === 0 ? { ...g, title: `${g.title} ${LONG}` } : g)) } : priorityCardFixture;
const width = Number(params.get("width")) || undefined;

function App() {
  const [ticked, setTicked] = useState(params.get("ticked") === "none" ? [] : fixtureTickedSome);
  const [last, setLast] = useState<PriorityCardAnswer | null>(null);
  const at = card.run.at + 61 * 60_000;
  const answered: PriorityCardAnswered | null =
    view === "answered" ? { kind: "accept", ids: fixtureTickedSome.filter((id) => id !== "c9"), text: "Text sign-in is how the shop kiosk works. Keep it.", about: "c9", at }
    : view === "correction" ? { kind: "text", ids: [], text: "Checkout stays at #9 until the holiday freeze; the rest can wait for next week's pass.", at }
    : view === "none" ? { kind: "none", ids: [], at }
    : null;
  return (
    <div className="min-h-screen bg-sol-bg text-sol-text" style={{ padding: width ? 0 : "28px 36px 60px" }}>
      <div style={{ maxWidth: width ?? 1100, padding: width ? "18px 16px 30px" : 0 }}>
        <PriorityChangeCard
          card={card}
          ticked={ticked}
          onToggle={setTicked}
          answered={answered}
          onAnswer={setLast}
          question={long ? `Should your priorities follow ${LONG}?` : "Should your priorities follow what you worked on today?"}
          context={long ? `Most of it went to ${LONG}.` : "A third of what you typed went to checkout, which sits at #9; nothing touched #1. I'd take all of it but the recipe import."}
        />
        {last && <pre className="mt-6 text-meta text-sol-text-dim" data-preview-answer>{JSON.stringify(last)}</pre>}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
