// Version 1 of every new app: the smallest app that shows the whole runtime
// working (a shared value and live faces), styled well enough to be worth
// changing. The first build starts from here.
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
      text: `import { useShared, usePresence } from "playground";

const NAME = ${JSON.stringify(appName)};

export default function App() {
  const [waves, setWaves] = useShared("waves", 0);
  const { people } = usePresence();

  return (
    <main className="stage">
      <section className="card">
        <div className="crowd">
          {people.map((p) => (
            <img key={p.id} src={p.avatar} alt={p.name} title={p.isMe ? \`\${p.name} (you)\` : p.name} />
          ))}
        </div>
        <h1>{NAME}</h1>
        <p className="lede">A fresh lump of clay. Open the room and say what it should become.</p>
        <button onClick={() => setWaves((n) => n + 1)}>Wave hello</button>
        <p className="count">{waves === 0 ? "Nobody has waved yet" : waves === 1 ? "1 wave so far" : \`\${waves} waves so far\`}</p>
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

.crowd img {
  width: 48px;
  height: 48px;
  margin-left: -12px;
  border: 2.5px solid var(--ink);
  border-radius: 35%;
  background: var(--sun);
  box-shadow: 2px 2px 0 var(--ink);
}

.crowd img:first-child { margin-left: 0; }

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
`,
    },
  ];
}
