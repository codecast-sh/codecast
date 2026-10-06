// Version 1 of every new app: the smallest app that shows the whole runtime
// working (live faces, a shared counter, a guestbook signed with faces),
// styled well enough to be worth changing. The first build starts from here.
import type { FileDraft } from "./files";
import { importMapScript } from "./runtime";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function seedFiles(appName: string): FileDraft[] {
  return [
    {
      path: "index.html",
      text: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(appName)}</title>
    ${importMapScript().replace(/\n/g, "\n    ")}
    <link rel="stylesheet" href="src/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="src/main.jsx"></script>
  </body>
</html>
`,
    },
    {
      path: "src/main.jsx",
      text: `import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
`,
    },
    {
      path: "src/App.jsx",
      text: `import { useState } from "react";
import { useCollection, useShared, usePresence, me } from "playground";

const NAME = ${JSON.stringify(appName)};

function Face({ person, size = 40 }) {
  return <img className="face" src={person.avatar} alt={person.name} title={person.name} width={size} height={size} />;
}

function Guestbook() {
  const { docs, insert } = useCollection("guestbook");
  const [text, setText] = useState("");
  const sign = (e) => {
    e.preventDefault();
    const words = text.trim();
    if (!words) return;
    insert({ text: words });
    setText("");
  };
  const notes = docs.slice(-12).reverse();

  return (
    <section className="book">
      <form onSubmit={sign}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={\`Sign as \${me.name}\`} maxLength={140} />
        <button type="submit">Sign</button>
      </form>
      <ul>
        {notes.map((note) => (
          <li key={note._id}>
            {note._by && <Face person={note._by} size={32} />}
            <p>
              <b>{note._by?.name ?? "Someone"}</b> {note.text}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function App() {
  const [waves, setWaves] = useShared("waves", 0);
  const { people } = usePresence();

  return (
    <main className="stage">
      <section className="card">
        <div className="crowd">
          {people.map((p) => (
            <Face key={p.id} person={p} size={48} />
          ))}
        </div>
        <h1>{NAME}</h1>
        <p className="lede">A fresh lump of clay. Open the room and say what it should become.</p>
        <button onClick={() => setWaves((n) => n + 1)}>Wave hello</button>
        <p className="count">{waves === 0 ? "Nobody has waved yet" : waves === 1 ? "1 wave so far" : \`\${waves} waves so far\`}</p>
        <Guestbook />
      </section>
    </main>
  );
}
`,
    },
    {
      path: "src/styles.css",
      text: `:root {
  --ink: #1d1631;
  --paper: #fffdf6;
  --sun: #ffd84a;
  --leaf: #2fd6a0;
  font-family: ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
  color: var(--ink);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at 18% 22%, #ffe9a8 0 18%, transparent 18.5%),
    radial-gradient(circle at 84% 78%, #c9f5e6 0 22%, transparent 22.5%),
    #fff4d6;
}

.stage {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.card {
  width: min(440px, 100%);
  padding: 36px 32px 28px;
  background: var(--paper);
  border: 3px solid var(--ink);
  border-radius: 28px;
  box-shadow: 8px 8px 0 var(--ink);
  text-align: center;
}

.crowd {
  display: flex;
  justify-content: center;
  min-height: 48px;
  margin-bottom: 16px;
}

.face {
  flex: none;
  border: 2.5px solid var(--ink);
  border-radius: 35%;
  background: var(--sun);
  box-shadow: 2px 2px 0 var(--ink);
}

.crowd .face { margin-left: -12px; }
.crowd .face:first-child { margin-left: 0; }

h1 {
  margin: 0 0 8px;
  font-size: clamp(32px, 8vw, 44px);
  line-height: 1;
  letter-spacing: -0.02em;
}

.lede {
  margin: 0 0 24px;
  font-size: 17px;
  line-height: 1.4;
  opacity: 0.75;
}

button {
  font: inherit;
  font-size: 18px;
  font-weight: 800;
  padding: 12px 26px;
  color: var(--ink);
  background: var(--leaf);
  border: 3px solid var(--ink);
  border-radius: 16px;
  box-shadow: 4px 4px 0 var(--ink);
  cursor: pointer;
  transition: transform 120ms, box-shadow 120ms;
}

button:hover { transform: translate(-1px, -1px); box-shadow: 5px 5px 0 var(--ink); }
button:active { transform: translate(4px, 4px); box-shadow: 0 0 0 var(--ink); transition-duration: 0ms; }

.count {
  margin: 16px 0 0;
  font-size: 14px;
  font-weight: 600;
  opacity: 0.6;
}

.book {
  margin-top: 28px;
  padding-top: 24px;
  border-top: 3px dashed var(--ink);
  text-align: left;
}

.book form { display: flex; gap: 8px; }

.book input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 16px;
  padding: 10px 14px;
  color: var(--ink);
  background: #fff;
  border: 3px solid var(--ink);
  border-radius: 14px;
  outline: none;
}

.book input:focus { box-shadow: 0 0 0 3px var(--sun); }
.book button { font-size: 16px; padding: 10px 18px; background: var(--sun); }

.book ul {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  display: grid;
  gap: 10px;
  max-height: 260px;
  overflow-y: auto;
}

.book li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  animation: arrive 260ms cubic-bezier(.2, 1.4, .4, 1);
}

.book li p {
  margin: 0;
  padding: 8px 12px;
  font-size: 15px;
  line-height: 1.35;
  background: #fff;
  border: 2.5px solid var(--ink);
  border-radius: 4px 14px 14px 14px;
  overflow-wrap: anywhere;
}

@keyframes arrive { from { opacity: 0; transform: translateY(-6px) scale(.96); } }
@media (prefers-reduced-motion: reduce) { .book li { animation: none; } }
`,
    },
  ];
}
