/**
 * Agent labels.
 *
 * Reported 2026-08-27: several rows in the agents list reading the same word.
 * They were separate sessions in one repository, labelled by project name. The
 * panel was fixed; the CLI was not, and went on printing four identical rows —
 * which is why the logic now lives here rather than in one renderer.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { agentLabels, projectName } from '../src/model/labels.js';
import type { Agent } from '../src/model/types.js';

const agent = (over: Partial<Agent> & { id: string }): Agent =>
  ({
    backend: 'claude',
    label: over.id,
    projectPath: null,
    gitBranch: null,
    model: null,
    effort: null,
    entrypoint: null,
    parentId: null,
    pid: null,
    state: 'live',
    startedAt: 0,
    lastActivityAt: 0,
    totals: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
    ...over,
  }) as Agent;

describe('projectName', () => {
  it('takes the directory name, on either separator', () => {
    expect(projectName({ projectPath: '/home/<user>/work/adjent' })).toBe('adjent');
    expect(projectName({ projectPath: 'C:\\dev\\adjent' })).toBe('adjent');
  });

  it('is null when there is no path', () => {
    expect(projectName({ projectPath: null })).toBeNull();
  });

  it('does not return an empty string for a trailing separator', () => {
    expect(projectName({ projectPath: '/work/adjent/' })).toBeNull();
  });
});

describe('agentLabels', () => {
  it('leaves a lone session in a project as just the project', () => {
    const a = agent({ id: 'claude:s1', label: 'some-session', projectPath: '/w/adjent' });
    expect(agentLabels([a]).get('claude:s1')).toBe('adjent');
  });

  it('separates two sessions in one project by their session names', () => {
    const one = agent({ id: 'claude:s1', label: 'refactor-pass', projectPath: '/w/adjent' });
    const two = agent({ id: 'claude:s2', label: 'docs-sweep', projectPath: '/w/adjent' });
    const labels = agentLabels([one, two]);

    expect(labels.get('claude:s1')).toBe('adjent · refactor-pass');
    expect(labels.get('claude:s2')).toBe('adjent · docs-sweep');
  });

  it('falls back to a short id when the vendor named no session', () => {
    // A session with no name carries the project basename as its label, which
    // distinguishes nothing.
    const one = agent({ id: 'claude:abcdef1234', label: 'adjent', projectPath: '/w/adjent' });
    const two = agent({ id: 'claude:9876543210', label: 'adjent', projectPath: '/w/adjent' });
    const labels = agentLabels([one, two]);

    expect(labels.get('claude:abcdef1234')).toBe('adjent · abcdef12');
    expect(labels.get('claude:9876543210')).toBe('adjent · 98765432');
  });

  it('only disambiguates the project that is crowded', () => {
    const a = agent({ id: 'claude:s1', label: 'one', projectPath: '/w/adjent' });
    const b = agent({ id: 'claude:s2', label: 'two', projectPath: '/w/adjent' });
    const c = agent({ id: 'claude:s3', label: 'three', projectPath: '/w/other' });
    const labels = agentLabels([a, b, c]);

    expect(labels.get('claude:s1')).toContain(' · ');
    expect(labels.get('claude:s3')).toBe('other');
  });

  it('uses the label when an agent has no project at all', () => {
    const a = agent({ id: 'codex:s1', label: 'nameless', projectPath: null });
    expect(agentLabels([a]).get('codex:s1')).toBe('nameless');
  });
});
