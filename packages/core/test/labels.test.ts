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

  it('falls back to the id tail when the vendor named no session', () => {
    // A session with no name carries an id fragment as its label, which
    // distinguishes nothing once two of them share a prefix.
    const one = agent({ id: 'claude:abcdef1234', label: 'adjent', projectPath: '/w/adjent' });
    const two = agent({ id: 'claude:9876543210', label: 'adjent', projectPath: '/w/adjent' });
    const labels = agentLabels([one, two]);

    // The tail, not the head: for a time-ordered id the head is the shared part.
    expect(labels.get('claude:abcdef1234')).toBe('adjent · cdef1234');
    expect(labels.get('claude:9876543210')).toBe('adjent · 76543210');
    expect(new Set(labels.values()).size).toBe(2);
  });

  /**
   * Synthetic regression example: six rows all reading
   * `demo-api · 11111111`. Codex thread ids are time-ordered, so sessions
   * started close together share a long prefix — in this synthetic fixture, six agents
   * share one 8-character prefix. The providers build their
   * fallback label from that prefix, so disambiguating with it disambiguated
   * nothing.
   */
  it('separates sessions whose ids share a prefix', () => {
    const shared = '11111111-0000-4000-8000-';
    const many = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff'].map((tail, i) =>
      agent({
        id: `codex:${shared}00000000${tail}`,
        // What the provider actually supplies: the head of the id.
        label: shared.slice(0, 8),
        projectPath: '/w/demo-api',
        totals: { input: i, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
      }),
    );

    const labels = agentLabels(many);
    expect(new Set(labels.values()).size).toBe(6);
    for (const l of labels.values()) expect(l).not.toBe('demo-api · 11111111');
  });

  it('guarantees unique labels, whatever the inputs look like', () => {
    // The invariant the previous version lacked: it disambiguated the project
    // and stopped, without checking the result was actually distinguishing.
    const awkward = [
      agent({ id: 'codex:aaaaaaaa1111', label: 'same', projectPath: '/w/p' }),
      agent({ id: 'codex:aaaaaaaa2222', label: 'same', projectPath: '/w/p' }),
      agent({ id: 'codex:aaaaaaaa3333', label: 'p', projectPath: '/w/p' }),
      agent({ id: 'claude:x', label: 'p', projectPath: null }),
      agent({ id: 'claude:y', label: 'p', projectPath: '/w/p' }),
    ];
    const labels = agentLabels(awkward);
    expect(labels.size).toBe(5);
    expect(new Set(labels.values()).size).toBe(5);
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
