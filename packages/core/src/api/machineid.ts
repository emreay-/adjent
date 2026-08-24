/**
 * The installation's opaque identity.
 *
 * A snapshot can leave this machine — piped to an orchestrator, posted to a
 * relay, pasted into an issue. So the id that travels with it is a random UUID
 * minted once and stored under `~/.adjent/`, and deliberately *not* derived
 * from a hostname, user name or MAC address: a derived id would let anyone
 * holding a payload work out whose machine produced it, which is exactly the
 * property a metadata-only tool must not have.
 *
 * It is stable because consumers key on it — losing it silently would look
 * like a second machine appearing.
 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { storeDir } from '../persist.js';

const FILE = 'machine.json';

/** Shape on disk. Versioned so a future field does not require a re-mint. */
interface MachineFile {
  version: number;
  machineId: string;
}

const looksLikeUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Read the id, minting one on first use. A missing *or* unreadable file mints
 * rather than throws: an unusable id must never be the reason the app cannot
 * report anything, and the cost of re-minting is one apparent new machine.
 */
export async function machineId(dir: string = storeDir()): Promise<string> {
  const file = path.join(dir, FILE);
  try {
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf-8'));
    const id = (raw as MachineFile | null)?.machineId;
    if (looksLikeUuid(id)) return id;
  } catch {
    /* absent, truncated, or not JSON — all mean "mint one" */
  }

  const minted = randomUUID();
  const body: MachineFile = { version: 1, machineId: minted };
  try {
    await fs.mkdir(dir, { recursive: true });
    // Written through a temp file: a crash mid-write would otherwise leave a
    // truncated id that re-mints on every launch.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(body), 'utf-8');
    await fs.rename(tmp, file);
  } catch {
    /* read-only home, full disk: use the id for this run rather than fail */
  }
  return minted;
}
