import { describe, test, expect } from 'bun:test';
import { githubRepository, repositoryName, repositoryJump, repositoryEventMatches, sessionRepository, taskRepository } from '../repoNavigation';

describe('repository entry points', () => {
  test('only GitHub origins become browser links', () => {
    for (const remote of ['git@github.com:Owner/Repo.git', 'https://github.com/Owner/Repo.git/', 'ssh://git@github.com/Owner/Repo.git']) expect(githubRepository(remote)).toBe('owner/repo');
    for (const remote of ['git@gitlab.com:owner/repo.git', 'https://github.com.evil/owner/repo', '/src/codecast', 'owner/repo', 'https://github.com/a/../b', 'https://github.com/a/b?token=x']) expect(githubRepository(remote)).toBeNull();
    expect(repositoryName('Owner/Repo')).toBe('owner/repo');
  });
  test('jump preserves branch case, slash refs, paths and line ranges', () => {
    expect(repositoryJump('Owner/Repo@Fix/UI:src/Hello World.ts#L2-L8')?.href).toBe('/repo/owner/repo/blob/Fix%2FUI?path=src%2FHello+World.ts#L2-L8');
    expect(repositoryJump('Owner/Repo@Fix/UI')?.href).toBe('/repo/owner/repo/tree/Fix%2FUI');
    expect(repositoryJump('https://github.com/Owner/Repo')?.href).toBe('/repo/owner/repo');
    expect(repositoryJump('Owner/Repo:README.md')?.href).toBe('/repo/owner/repo/blob/HEAD?path=README.md');
    expect(repositoryJump('a/b:README.md#L8-L2')?.href).toBe('/repo/a/b/blob/HEAD?path=README.md#L2-L8');
  });
  test('does not turn arbitrary or unsafe search input into navigation', () => {
    for (const text of ['foo', 'https://evil.com/a/b', 'a/b:../secret', 'a/b:/private', 'a/b#L8', 'a/b:file#L0', 'a/b:file#L1-L0', 'a/b@main:<script>?x', 'a/..']) expect(repositoryJump(text)).toBeNull();
  });
  test('session repository fallback comes only from its bound PR', () => {
    expect(sessionRepository({git_remote_url: 'git@github.com:a/b.git'})).toBe('a/b');
    expect(sessionRepository({pr_status: {repository:'c/d'}})).toBe('c/d');
    expect(sessionRepository({git_remote_url:'/src/codecast'})).toBeNull();
  });
  test('related code stays scoped to explicit entity links', () => {
    const event = { repository:'a/b', task_ids:['task1'], plan_ids:['plan1'], project_ids:['project1'], conversation_ids:['session1'] };
    for (const scope of [{taskId:'task1'},{planId:'plan1'},{projectId:'project1'},{conversationIds:['session1']}]) expect(repositoryEventMatches(event, scope)).toBe(true);
    for (const scope of [{}, {taskId:'other'}, {conversationIds:[]}]) expect(repositoryEventMatches(event, scope)).toBe(false);
    expect(repositoryEventMatches({task_id:'task1'}, {taskId:'task1'})).toBe(true);
  });
  test('imported GitHub tasks carry repository links before any session starts', () => {
    expect(taskRepository({external: {provider: 'github', identifier: 'Owner/Repo#42'}})).toBe('owner/repo');
    expect(taskRepository({external: {provider: 'linear', identifier: 'CODE-42'}})).toBeNull();
    expect(taskRepository({external: {provider: 'github'}})).toBeNull();
  });
});
