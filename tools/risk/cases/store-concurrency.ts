// R1: many processes on one shared db (the ~/.chorus/chorus.db move, ui-plan item 8).
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Store } from '../../../src/core/store.ts';
import { save, tmpWorkspace, type Case } from '../lib.ts';

const WORKER = path.resolve(import.meta.dirname, '../workers/store-worker.ts');

export default {
  id: 'store-concurrency',
  title: 'Shared SQLite store under many writer processes',
  cost: 'free',
  async run(ctx) {
    const rounds = 150;
    const results: Record<string, any> = {};
    for (const n of [4, 12, 24]) {
      const project = tmpWorkspace('db' + n);
      new Store(project).close(); // schema first, like the app does
      const outs = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          new Promise<any>((resolve, reject) => {
            const c = spawn(process.execPath, [WORKER, project, `w${i}`, String(rounds)], { stdio: ['ignore', 'pipe', 'pipe'] });
            let o = '', e = '';
            c.stdout.on('data', d => (o += d));
            c.stderr.on('data', d => (e += d));
            c.on('close', code => (code === 0 ? resolve(JSON.parse(o.trim().split('\n').pop()!)) : reject(new Error(e.slice(0, 400)))));
          }).catch(e => ({ crashed: String(e.message) })),
        ),
      );
      const s = new Store(project);
      const calls = (s.db.prepare('SELECT COUNT(*) n FROM mcp_calls').get() as any).n;
      const threads = s.listThreads().length;
      s.close();
      const expectedCalls = outs.reduce((a, o) => a + (o.done ?? 0), 0);
      results[`writers_${n}`] = {
        crashed: outs.filter(o => o.crashed).length,
        busyErrors: outs.reduce((a, o) => a + (o.busy ?? 0), 0),
        worstWriteMs: Math.max(...outs.map(o => o.maxMs ?? 0)),
        threads,
        mcpCallsLogged: calls,
        mcpCallsExpected: expectedCalls,
        lost: expectedCalls - calls,
      };
      fs.rmSync(project, { recursive: true, force: true });
    }
    save(ctx, 'store-concurrency.json', results);
    const bad = Object.values(results).some((r: any) => r.crashed || r.busyErrors || r.lost);
    const worst = Math.max(...Object.values(results).map((r: any) => r.worstWriteMs));
    return {
      status: bad ? 'fail' : 'pass',
      summary: bad ? 'lost writes or busy errors under load' : `no lost writes or busy errors up to 24 writer processes; worst single write ${worst} ms`,
      facts: { ...results, host: os.platform() },
    };
  },
} satisfies Case;
