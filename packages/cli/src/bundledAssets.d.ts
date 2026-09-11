// Text imports (`with { type: "text" }`) of the skill, agent and hook script
// files the CLI installs. bun inlines them as strings in every build, dev and
// compiled; these declarations are what lets tsc agree.
declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.sh" {
  const text: string;
  export default text;
}
