// What `cast mod new <name>` writes: a mod that already works (a pane, a
// command and a fence) so the first `cast mod dev` shows something real, and
// the author edits from there instead of from an empty file.

import { MANIFEST_FILE, TYPES_FILE, authoringTypes } from "./build.js";

function titleOf(name: string): string {
  return name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function scaffoldFiles(name: string): Record<string, string> {
  const title = titleOf(name);
  const manifest = {
    name,
    title,
    description: "What this mod adds, in one line.",
    icon: "sparkles",
    permissions: { read: ["sessions"], write: ["tasks"] },
    panes: [{ id: "main", title }],
    commands: [{ id: "open", title: `Open ${title}`, keywords: name.replace(/-/g, " ") }],
    fences: [{ lang: `${name}-note`, description: "A callout an agent can emit" }],
  };
  const ui = `import { h, Fragment, Row, Column, Card, Grid, Stat, Table, Button, Text, Markdown, Empty, type Register } from "codecast-mod";

// The hooks module: codecast calls register(on) once when the mod loads.
// Every hook is ($, e, next): $ is the codecast API, e the event, next() the
// rest of the chain. Types and every element: ${TYPES_FILE}.
export const register: Register = (on) => {
  on("ui.render", { pane: "main" }, async ($) => {
    const sessions = await $.data.list("sessions", {
      sort: "updated_at",
      order: "desc",
      limit: 300,
      fields: ["title", "state", "updated_at", "agent_type", "project"],
    });
    const count = (state: string) => sessions.filter((s) => s.state === state).length;
    const waiting = sessions.filter((s) => s.state === "needs_input").slice(0, 12);
    return (
      <Column gap={4} pad={4}>
        <Grid columns={4} gap={3}>
          <Stat label="Working" value={count("working")} tone="blue" />
          <Stat label="Needs you" value={count("needs_input")} tone="yellow" />
          <Stat label="Done" value={count("done")} tone="green" />
          <Stat label="Parked" value={count("dormant")} tone="violet" />
        </Grid>
        <Card title="Waiting on you" actions={<Button label="New task" variant="ghost" icon="plus" onPress={() => $.tasks.create({ title: "Follow up on waiting sessions" }).then(() => $.ui.toast("Task created", { kind: "success" }))} />}>
          {waiting.length ? (
            <Table
              rows={waiting}
              columns={[{ key: "_id", label: "Session", as: "ref" }, { key: "agent_type", label: "Agent" }, { key: "updated_at", label: "Updated", as: "time", align: "right" }]}
              onRowPress={(row) => $.sessions.open(String(row._id))}
            />
          ) : (
            <Empty title="Nothing waiting" hint="Every session is working or settled." icon="check" />
          )}
        </Card>
      </Column>
    );
  });

  on("command.run", { command: "open" }, async ($) => {
    await $.ui.open("main");
  });

  // Any agent can now write a \`\`\`${name}-note block and it draws like this.
  on("ui.render", { fence: "${name}-note" }, async ($, e) => (
    <Card tone="blue">
      <Row gap={2} align="start">
        <Text tone="blue" weight="semibold">Note</Text>
        <Markdown text={e.props.code} />
      </Row>
    </Card>
  ));
};
`;
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react",
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["bun"],
    },
    include: ["*.ts", "*.tsx", TYPES_FILE],
  };
  // Its own compiler, so `cast mod build` typechecks the mod on any machine
  // rather than finding no tsc; @types/bun types a local half's node: imports.
  const pkg = { name, private: true, devDependencies: { typescript: "^5.7.2", "@types/bun": "^1.3.3" } };
  return {
    [MANIFEST_FILE]: `${JSON.stringify(manifest, null, 2)}\n`,
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "ui.tsx": ui,
    "tsconfig.json": `${JSON.stringify(tsconfig, null, 2)}\n`,
    [TYPES_FILE]: authoringTypes(),
    ".gitignore": `${TYPES_FILE}\nnode_modules\n`,
  };
}
