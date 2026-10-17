// The compact digest a new agent loads to continue another agent's work (docs/architecture.md §7).
import type { Store, ThreadRow } from './store.ts';

const TEST_CMD = /\b(test|jest|vitest|pytest|mocha|cargo test|go test|npm run (test|check)|tsc|lint)\b/i;
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|write_to_file|replace_file_content|apply_patch|file_change)$/;
const WRITES_BY_SHELL = />\s*(\S+\.\w+)|\btee\s+(\S+)|\bsed -i\b.*\s(\S+\.\w+)\s*$/;

export interface Handoff {
  thread: ThreadRow;
  text: string;
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function pickSourceThread(store: Store, current: string | undefined, requested?: string): ThreadRow | undefined {
  if (requested) return store.getThread(requested);
  const me = current ? store.getThread(current) : undefined;
  if (me?.parent_thread_id) return store.getThread(me.parent_thread_id);
  return store.listThreads().find(t => t.id !== current);
}

export function buildHandoff(store: Store, thread: ThreadRow, opts: { maxTurns?: number; maxChars?: number } = {}): Handoff {
  const maxTurns = opts.maxTurns ?? 6;
  const turns = store.getTurns(thread.id, { limit: 10000 });
  const calls = store.getToolCalls(thread.id);
  const usage = store.getUsage(thread.id);
  const artifacts = store.listArtifacts(thread.id);

  const first = turns.find(t => t.role === 'user');
  const lastAssistant = [...turns].reverse().find(t => t.role === 'assistant');
  const recent = turns.slice(-maxTurns);

  const files = new Set<string>();
  const commands: string[] = [];
  const tests: string[] = [];
  const failures: string[] = [];
  for (const c of calls) {
    const isShell = c.tool === 'Bash' || c.tool === 'shell' || c.tool === 'run_command';
    if (FILE_TOOLS.test(c.tool) && c.target) files.add(c.target);
    if (isShell) {
      const w = c.target.match(WRITES_BY_SHELL);
      const written = w && (w[1] || w[2] || w[3]);
      if (written && !written.startsWith('/dev/')) files.add(written);
      const line = `${c.status === 'ok' ? '✓' : c.status === 'failed' ? '✗' : '…'} ${clip(c.target, 140)}`;
      commands.push(line);
      if (TEST_CMD.test(c.target)) tests.push(`${line}${c.result ? ` → ${clip(c.result, 120)}` : ''}`);
    }
    if (c.status === 'failed') failures.push(`${c.tool} ${clip(c.target, 100)}${c.result ? ` → ${clip(c.result, 100)}` : ''}`);
  }

  const out: string[] = [];
  out.push(`# Handoff from Chorus thread "${thread.title}" (${thread.agent}${thread.model ? ', ' + thread.model : ''})`);
  out.push(`Working directory: ${thread.cwd}`);
  if (first) out.push(`\n## First request\n${clip(first.text, 1500)}`);
  if (files.size) out.push(`\n## Files touched\n${[...files].map(f => `- ${f}`).join('\n')}`);
  if (commands.length) out.push(`\n## Commands run (${commands.length})\n${commands.slice(-12).join('\n')}`);
  if (tests.length) out.push(`\n## Tests / checks\n${tests.slice(-6).join('\n')}`);
  if (failures.length) out.push(`\n## Failed tool calls\n${failures.slice(-5).map(f => `- ${f}`).join('\n')}`);
  if (artifacts.length) out.push(`\n## Artifacts\n${artifacts.map(a => `- ${a.abs}`).join('\n')}`);
  out.push(`\n## Recent conversation (last ${recent.length} of ${turns.length} turns)\n` + recent.map(t => `**${t.role}:** ${clip(t.text, 800)}`).join('\n\n'));
  if (lastAssistant) out.push(`\n## Last assistant message\n${clip(lastAssistant.text, 1500)}`);
  if (usage?.limitUtilization != null) out.push(`\n(plan usage when captured: ${Math.round(usage.limitUtilization * 100)}%)`);
  out.push(`\nOlder turns: call get_thread_turns with thread_id "${thread.id}".`);

  return { thread, text: clip(out.join('\n'), opts.maxChars ?? 12000) };
}

/** First message for a handoff thread (docs/architecture.md §7). Fixed text, no model involved. */
export function handoffPrompt(from: ThreadRow): string {
  return (
    `This chat continues the Chorus thread "${from.title}", worked on by ${from.agent}. ` +
    'Call the chorus MCP tool get_handoff_context first. Then reply with at most 5 bullets: ' +
    'what was done, decisions, open work, and your next step. Wait for my OK before changing anything.'
  );
}
