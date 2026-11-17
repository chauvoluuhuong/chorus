// Which chat a `chorus mcp` process belongs to: the one whose CLI started it. Chorus records each chat's CLI pid when it spawns it
// (threads.cli_pid); the server walks its own ancestor processes and takes the nearest one that is a live chat's CLI. agy starts its
// server lazily from a config every agy chat in one folder shares, so the --thread it was given can be another chat's (probe D,
// chorus-core 56b00d9: the CLI pid is among the server's ancestors 6/6). Nothing matches (headless runs, tests, an AI app the user
// connected): --thread as given.
import { spawnSync } from 'node:child_process';
import type { Store } from '../core/store.ts';

/** The ancestors of a process, nearest first (its parent, then the parent's parent …), from one `ps` listing. */
export function ancestorPids(pid: number, list: () => string = psList): number[] {
  const parent = new Map<number, number>();
  for (const line of list().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) parent.set(Number(m[1]), Number(m[2]));
  }
  const out: number[] = [];
  for (let p = parent.get(pid); p && p > 1 && !out.includes(p) && out.length < 64; p = parent.get(p)) out.push(p);
  return out;
}

function psList(): string {
  try {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
    return r.status === 0 ? r.stdout : '';
  } catch {
    return '';
  }
}

/** The chat whose CLI is the nearest of these ancestors, else `fallback`. */
export function resolveThread(store: Store, fallback: string | undefined, ancestors: number[]): string | undefined {
  for (const pid of ancestors) {
    const t = store.threadByCliPid(pid);
    if (t) return t.id;
  }
  return fallback;
}
