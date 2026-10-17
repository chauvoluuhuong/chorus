// Non-interactive commands: everything the app does is also a plain command (mockup §Commands).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { adapters, VERIFIED_VERSION, versionWarning } from '../core/adapters/index.ts';
import { buildHandoff } from '../core/handoff.ts';
import { homes } from '../core/launch.ts';
import type { Store } from '../core/store.ts';
import type { AgentId } from '../core/types.ts';

const AGENTS: AgentId[] = ['claude', 'codex', 'agy'];
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

export function threadsCmd(store: Store): string {
  const rows = store.listThreads();
  if (!rows.length) return 'no threads yet. Start one with: chorus new --agent claude';
  return [
    `${pad('id', 12)}${pad('agent', 8)}${pad('state', 9)}${pad('parent', 12)}title`,
    ...rows.map(t => `${pad(t.id, 12)}${pad(t.agent, 8)}${pad(t.state, 9)}${pad(t.parent_thread_id ?? '-', 12)}${t.title}`),
  ].join('\n');
}

export function showCmd(store: Store, id: string): string {
  const t = store.getThread(id) ?? store.listThreads().find(x => x.id.startsWith(id));
  if (!t) return `unknown thread ${id}`;
  const turns = store.getTurns(t.id, { limit: 10000 });
  const calls = store.getToolCalls(t.id);
  const children = store.listThreads().filter(x => x.parent_thread_id === t.id);
  const out = [`${t.title}  (${t.id}, ${t.agent}${t.model ? ', ' + t.model : ''}, ${t.state})`, `cwd: ${t.cwd}`, t.parent_thread_id ? `continues: ${t.parent_thread_id}` : '', children.length ? `continued by: ${children.map(c => `${c.id} (${c.agent})`).join(', ')}` : '', '', '## turns'];
  for (const x of turns) out.push(`[${x.seq}] ${x.role}: ${x.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  out.push('', '## tool calls');
  for (const c of calls) out.push(`${c.status === 'ok' ? '✓' : c.status === 'failed' ? '✗' : '…'} ${c.tool} ${c.target.slice(0, 100)}${c.result ? ` → ${c.result.slice(0, 80)}` : ''}`);
  return out.filter((l, i) => l !== '' || i > 3).join('\n');
}

export function memoryCmd(store: Store, id: string): string {
  const t = store.getThread(id);
  return t ? buildHandoff(store, t).text : `unknown thread ${id}`;
}

export function artifactsCmd(store: Store, thread?: string): string {
  const rows = store.listArtifacts(thread);
  return rows.length ? rows.map(a => `${a.thread_id}\t${a.version}\t${a.abs}`).join('\n') : 'no artifacts yet';
}

export function activityCmd(store: Store, thread?: string): string {
  const rows = thread ? [store.getThread(thread)].filter(Boolean) : store.listThreads();
  const out = [`${pad('thread', 12)}${pad('agent', 8)}${pad('turns', 7)}${pad('tools', 7)}${pad('mcp', 6)}${pad('tokens in/out', 18)}${pad('cost', 9)}limit`];
  for (const t of rows as NonNullable<ReturnType<Store['getThread']>>[]) {
    const u = store.getUsage(t.id);
    out.push(
      `${pad(t.id, 12)}${pad(t.agent, 8)}${pad(String(store.getTurns(t.id, { limit: 100000 }).length), 7)}${pad(String(store.getToolCalls(t.id).length), 7)}${pad(String(store.mcpCalls(t.id).length), 6)}${pad(u ? `${u.inputTokens}/${u.outputTokens}` : '-', 18)}${pad(u?.costUsd != null ? '$' + u.costUsd.toFixed(4) : '-', 9)}${u?.limitUtilization != null ? Math.round(u.limitUtilization * 100) + '%' : '-'}`,
    );
  }
  return out.join('\n');
}

/** Raw capture next to what Chorus parsed from it (debugging an adapter). */
export function traceCmd(store: Store, id: string): string {
  const t = store.getThread(id);
  if (!t) return `unknown thread ${id}`;
  const out = [`thread ${t.id} (${t.agent} ${t.cli_version ?? '?'})`];
  const raw = path.join(store.threadDir(t.id), 'raw', 'pty.log');
  out.push(`raw terminal capture: ${fs.existsSync(raw) ? `${raw} (${fs.statSync(raw).size} bytes)` : 'none'}`);
  out.push(`transcript: ${t.transcript_path ?? 'not found'}`);
  if (t.transcript_path && fs.existsSync(t.transcript_path)) {
    const text = fs.readFileSync(t.transcript_path, 'utf8');
    const lines = text.split('\n').filter(l => l.trim());
    const s = adapters[t.agent].parseTranscript(text);
    out.push(`transcript lines: ${lines.length}  → parsed turns: ${s.turns.length}, tool calls: ${s.toolCalls.length}, status: ${s.status ?? '?'}`);
    out.push('', 'last raw lines (cut) → what we made of the session:');
    for (const l of lines.slice(-5)) out.push('  raw  ' + l.slice(0, 160));
    for (const c of s.toolCalls.slice(-5)) out.push(`  tool ${c.status} ${c.tool} ${c.target.slice(0, 80)}`);
    for (const x of s.turns.slice(-3)) out.push(`  turn ${x.role}: ${x.text.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  out.push('', `MCP calls from this thread: ${store.mcpCalls(t.id).map(m => m.tool).join(', ') || 'none'}`);
  return out.join('\n');
}

function run(bin: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export function doctorCmd(project: string): string {
  const out = ['chorus doctor', ''];
  out.push(`node ${process.version}${Number(process.versions.node.split('.')[0]) >= 22 ? '' : '  ⚠ Node 22+ needed'}`);
  out.push(`project: ${project}`, `store: ${path.join(project, '.chorus', 'chorus.db')} ${fs.existsSync(path.join(project, '.chorus', 'chorus.db')) ? '(exists)' : '(created on first use)'}`, '');
  for (const a of AGENTS) {
    const v = run(a, ['--version']);
    if (!v.ok) {
      out.push(`${a.padEnd(7)} not installed (or not on PATH)`);
      continue;
    }
    const version = (v.out.match(/\d+\.\d+\.\d+/) ?? ['?'])[0];
    let login = 'unknown';
    if (a === 'claude') {
      try {
        login = JSON.parse(run('claude', ['auth', 'status']).out).loggedIn ? 'logged in' : 'NOT logged in: run claude auth login';
      } catch {
        login = 'unknown';
      }
    } else if (a === 'codex') {
      const s = run('codex', ['login', 'status']);
      login = /logged in/i.test(s.out) ? 'logged in' : 'NOT logged in: run codex login';
    } else login = fs.existsSync(path.join(homes.agy(), '..', 'settings.json')) ? 'has a settings file (no status command; start agy once to sign in)' : 'unknown (no status command)';
    const warn = versionWarning(a, version);
    out.push(`${a.padEnd(7)} ${version.padEnd(9)} verified ${VERIFIED_VERSION[a].padEnd(8)} ${login}${warn ? `\n        ⚠ ${warn}` : ''}`);
    out.push(`        data: ${a === 'claude' ? homes.claude() : a === 'codex' ? homes.codex() : homes.agy()}`);
  }
  return out.join('\n');
}
