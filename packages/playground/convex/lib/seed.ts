// Version 1 of every new app: the smallest app that shows the whole runtime
// working (live faces, a shared counter, notes signed with faces), in a calm,
// neutral style that reads as a placeholder. The first build replaces it.
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

function Face({ person, size = 32 }) {
  return <img className="face" src={person.avatar} alt={person.name} title={person.name} width={size} height={size} />;
}

function Notes() {
  const { docs, insert } = useCollection("notes");
  const [text, setText] = useState("");
  const leave = (e) => {
    e.preventDefault();
    const words = text.trim();
    if (!words) return;
    insert({ text: words });
    setText("");
  };

  return (
    <section className="notes">
      <form onSubmit={leave}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={\`Leave a note as \${me.name}\`} maxLength={140} />
        <button type="submit">Post</button>
      </form>
      <ul>
        {docs.slice(-8).reverse().map((note) => (
          <li key={note._id}>
            {note._by && <Face person={note._by} size={28} />}
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
    <main>
      <header>
        <h1>{NAME}</h1>
        <div className="crowd" aria-label={\`\${people.length} here\`}>
          {people.map((p) => (
            <Face key={p.id} person={p} />
          ))}
        </div>
      </header>
      <p className="lede">This app is new. Open the room and say what it should become.</p>
      <div className="wave">
        <button onClick={() => setWaves((n) => n + 1)}>Wave hello</button>
        <span>{waves === 0 ? "Nobody has waved yet" : waves === 1 ? "1 wave so far" : \`\${waves} waves so far\`}</span>
      </div>
      <Notes />
    </main>
  );
}
`,
    },
    {
      path: "src/styles.css",
      text: `:root {
  --ink: #2b2520;
  --ink-soft: #6f655c;
  --paper: #f7f3ec;
  --surface: #fffdf9;
  --line: #e2d9cc;
  --accent: #c4491f;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--paper);
}

* { box-sizing: border-box; }

body { margin: 0; }

main {
  width: min(560px, 100%);
  margin: 0 auto;
  padding: clamp(32px, 10vh, 96px) 20px 48px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

h1 {
  margin: 0;
  font-size: clamp(28px, 7vw, 36px);
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.lede {
  margin: 10px 0 32px;
  font-size: 16px;
  line-height: 1.5;
  color: var(--ink-soft);
}

.crowd { display: flex; flex: none; }
.crowd .face + .face { margin-left: -8px; }

.face {
  flex: none;
  border-radius: 50%;
  background: var(--line);
  box-shadow: 0 0 0 2px var(--paper);
}

button {
  font: inherit;
  font-weight: 600;
  min-height: 44px;
  padding: 0 18px;
  color: #fff;
  background: var(--accent);
  border: 0;
  border-radius: 10px;
  cursor: pointer;
}

button:active { transform: scale(0.97); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.wave {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 14px;
  color: var(--ink-soft);
}

.notes { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); }
.notes form { display: flex; gap: 8px; }

.notes input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  font: inherit;
  padding: 0 14px;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.notes button { color: var(--ink); background: var(--surface); border: 1px solid var(--line); }

.notes ul { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 12px; }
.notes li { display: flex; align-items: flex-start; gap: 10px; animation: arrive 200ms ease-out; }
.notes li p { margin: 4px 0 0; font-size: 15px; line-height: 1.45; overflow-wrap: anywhere; }

@keyframes arrive { from { opacity: 0; transform: translateY(-4px); } }
@media (prefers-reduced-motion: reduce) { .notes li { animation: none; } }
`,
    },
  ];
}
