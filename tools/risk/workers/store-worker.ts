// One writer process for the store-concurrency case: mimics a thread tailer + an MCP server on the same db.
import { Store } from '../../../src/core/store.ts';

const [project, id, rounds] = process.argv.slice(2);
const store = new Store(project);
store.createThread({ id, title: id, agent: 'claude', cwd: project });
let busy = 0;
let done = 0;
const t0 = Date.now();
let maxMs = 0;
for (let i = 1; i <= Number(rounds); i++) {
  const t = Date.now();
  try {
    const turns = Array.from({ length: i }, (_, k) => ({ seq: k + 1, role: (k % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: 'x'.repeat(200) }));
    store.recordSession(id, { agent: 'claude', turns, toolCalls: [{ id: 'c' + i, turnSeq: i, tool: 'Bash', target: 'ls', status: 'ok' }], usage: { inputTokens: i, outputTokens: i, cacheReadTokens: 0 } });
    store.logMcpCall(id, 'get_thread_turns');
    store.listThreads();
    done++;
  } catch (e: any) {
    if (/locked|busy/i.test(String(e?.message))) busy++;
    else throw e;
  }
  maxMs = Math.max(maxMs, Date.now() - t);
}
console.log(JSON.stringify({ id, done, busy, maxMs, totalMs: Date.now() - t0 }));
store.close();
