import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('Code is reachable from the main rail and command menu', () => {
  expect(read('components/Sidebar.tsx')).toMatch(/label="Code"\s+href="\/repo"/);
  expect(read('components/CommandPalette.tsx')).toContain('label: "Code", path: "/repo"');
  expect(read('components/CommandPalette.tsx')).toContain('<RepositoryPaletteItems');
});

test('session branch opens the internal browser and object pages expose related code', () => {
  for (const file of ['components/ConversationView.tsx', 'components/GlobalSessionPanel.tsx']) expect(read(file)).toContain('<BranchCodeLink session=');
  for (const file of ['app/tasks/[id]/page.tsx', 'app/plans/[id]/page.tsx', 'app/projects/[id]/page.tsx', 'components/PlanDetailPanel.tsx']) expect(read(file)).toContain('<RepositoryLinks ');
  expect(read('components/ConversationView.tsx')).not.toContain('window.open(`https://github.com/${match[1]}/tree/');
  expect(read('components/ConversationView.tsx')).toContain('const codeRouter = useRouter();');
  expect(read('components/ConversationView.tsx')).toContain('codeRouter.push(repoTreeHref(');
  expect(read('components/ConversationView.tsx')).toContain('codeRouter.push(repoCommitsHref(');
});

test('main and nested session projections carry the repository origin', () => {
  const convex = readFileSync(new URL('../../../convex/convex/conversations.ts', import.meta.url), 'utf8');
  expect(convex).toContain('git_remote_url: conv.git_remote_url,');
  expect(convex).toContain('git_remote_url: child.git_remote_url,');
  expect(read('store/inboxStore.ts')).toContain('s.git_remote_url || ""');
});

test('plan code links are visible without opening its Info panel', () => {
  const page = read('app/plans/[id]/page.tsx');
  const lead = page.slice(page.indexOf('leadContent={'), page.indexOf('topBarLeft={'));
  expect(lead).toContain('<RepositoryLinks planId={plan._id}');
  expect(page.match(/<RepositoryLinks /g)).toHaveLength(1);
});
