/** Location-only reports: never copy a suspected secret into CI logs. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const patterns = [
  ['home path', /(?:[a-z]:[\\/]+users[\\/]+[a-z0-9._-]+|\/(?:home|Users)\/[a-z0-9._-]+)/gi],
  ['credential shape', /(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/gi],
  ['truncated identifier', /\b[0-9a-f]{8}-\.{3}/gi],
  ['account-derived example', /(?:measured\s+on\s+this\s+machine|probed\s+with\s+this\s+machine|on\s+this\s+machine\)\s*and|last\s+\d+\s+days\s+on\s+this\s+machine)/gi],
];

export function inspectText(text) {
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    for (const [kind, pattern] of patterns) {
      // Allow only the matched CI path, never an entire line containing it.
      const hits = [...line.matchAll(pattern)].filter((m) =>
        !(kind === 'home path' && m[0] === '/home/runner'),
      );
      if (hits.length) findings.push({ line: index + 1, kind });
    }
  }
  return findings;
}

function git(args, options = {}) {
  return execFileSync('git', ['-c', `safe.directory=${root.replace(/\\/g, '/')}`, ...args], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024, ...options,
  });
}

function report(label, data) {
  const findings = inspectText(data.toString('utf8'));
  for (const finding of findings) console.error(`${label}:${finding.line}: ${finding.kind} (value withheld)`);
  return findings.length;
}

export function scan(history = false) {
  let count = 0;
  if (history) {
    const objects = git(['rev-list', '--objects', '--all']).toString().trim().split('\n').filter(Boolean)
      .map((line) => { const split = line.indexOf(' '); return split < 0 ? [line, ''] : [line.slice(0, split), line.slice(split + 1)]; });
    const metadata = git(['cat-file', '--batch-check'], { input: objects.map(([oid]) => oid).join('\n') + '\n' })
      .toString().trim().split('\n');
    const blobs = objects.filter((_object, i) => metadata[i].split(' ')[1] === 'blob');
    // Small batches avoid both a process per blob and retaining the whole history.
    for (let i = 0; i < blobs.length; i += 20) {
      const batch = blobs.slice(i, i + 20);
      const data = git(['cat-file', '--batch'], { input: batch.map(([oid]) => oid).join('\n') + '\n' });
      let position = 0;
      for (const [oid, name] of batch) {
        const end = data.indexOf(10, position);
        const size = Number(data.subarray(position, end).toString().split(' ')[2]);
        count += report(`${oid.slice(0, 12)}:${name}`, data.subarray(end + 1, end + 1 + size));
        position = end + 2 + size;
      }
    }
    const commits = git(['rev-list', '--all']).toString().trim().split('\n').filter(Boolean);
    for (const oid of commits) count += report(`${oid.slice(0, 12)}:commit-message`, git(['show', '-s', '--format=%B', oid]));
    console.log(`Reviewed ${blobs.length} reachable file versions and ${commits.length} commit messages.`);
    console.log('Review author/committer identities, image metadata, account figures, and remote logs separately.');
  } else {
    const files = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean));
    for (const name of files) {
      let data;
      try { data = readFileSync(path.join(root, name)); } catch (error) {
        if (error.code === 'ENOENT') continue; // a tracked deletion
        throw error;
      }
      count += report(name, data);
    }
    console.log(`Reviewed ${files.size} tracked and non-ignored working files.`);
  }
  console.log(`${count} potential findings. Pattern checks do not prove that examples are synthetic.`);
  return count;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = scan(process.argv.includes('--history')) ? 1 : 0;
  } catch {
    console.error('Repository scan could not finish. Check Git access and file permissions locally; error details withheld.');
    process.exitCode = 2;
  }
}
