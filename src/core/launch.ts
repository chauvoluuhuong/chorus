// How to start each CLI for one Chorus thread (flags verified in docs/integrations/*.md).
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_NAMES } from '../mcp/server.ts';
import type { AgentId } from './types.ts';

const CLI_ENTRY = path.resolve(import.meta.dirname, '../cli/index.ts');
/** Variables a parent Claude Code session leaks into children (CLAUDE.md rule 5). */
const SCRUB_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID'];

export interface LaunchOpts {
  prompt: string;
  cwd: string;
  /** project dir that holds .chorus/ */
  project: string;
  threadId: string;
  resumeId?: string;
  model?: string;
}

export interface Launch {
  bin: string;
  args: string[];
  cwd: string;
  /** session id we choose up front (claude only) */
  sessionId?: string;
}

export function mcpCommand(project: string, threadId: string) {
  return { command: process.execPath, args: [CLI_ENTRY, 'mcp', '--project', project, '--thread', threadId] };
}

const q = (s: string) => JSON.stringify(s);

export function buildHeadless(agent: AgentId, o: LaunchOpts): Launch {
  const mcp = mcpCommand(o.project, o.threadId);
  if (agent === 'claude') {
    const sessionId = o.resumeId ? undefined : randomUUID();
    return {
      bin: 'claude',
      cwd: o.cwd,
      sessionId,
      args: [
        '-p', o.prompt,
        ...(o.resumeId ? ['--resume', o.resumeId] : ['--session-id', sessionId!]),
        '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'acceptEdits',
        ...(o.model ? ['--model', o.model] : []),
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { chorus: mcp } }),
        '--allowedTools', TOOL_NAMES.map(t => `mcp__chorus__${t}`).join(','),
      ],
    };
  }
  if (agent === 'codex') {
    const common = [
      '--json', '--skip-git-repo-check', '-s', 'workspace-write',
      ...(o.model ? ['-m', o.model] : []),
      '-c', `mcp_servers.chorus.command=${q(mcp.command)}`,
      '-c', `mcp_servers.chorus.args=[${mcp.args.map(q).join(',')}]`,
      '-c', 'mcp_servers.chorus.default_tools_approval_mode="approve"',
      '-c', 'approval_policy="never"',
    ];
    return { bin: 'codex', cwd: o.cwd, args: o.resumeId ? ['exec', ...common, 'resume', o.resumeId, o.prompt] : ['exec', ...common, o.prompt] };
  }
  // agy: no per-session flag; a workspace .agents/mcp_config.json is read (verified 1.4.0)
  writeAgyMcpConfig(o.cwd, mcp);
  return {
    bin: 'agy',
    cwd: o.cwd,
    args: [...(o.resumeId ? ['--conversation', o.resumeId] : []), '-p', o.prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions', ...(o.model ? ['--model', o.model] : [])],
  };
}

/** Merge our server into the workspace file without dropping the user's own servers. */
export function writeAgyMcpConfig(cwd: string, mcp: { command: string; args: string[] }) {
  const file = path.join(cwd, '.agents', 'mcp_config.json');
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* new file */
  }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), chorus: mcp };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export function run(l: Launch, opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const env = { ...process.env };
  for (const k of SCRUB_ENV) delete env[k];
  return new Promise(resolve => {
    const child = spawn(l.bin, l.args, { cwd: l.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 300_000);
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(e), code: null, timedOut });
    });
  });
}

export const homes = {
  claude: () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
  codex: () => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
  agy: () => path.join(os.homedir(), '.gemini', 'antigravity-cli'),
};
