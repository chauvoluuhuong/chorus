// How to start each CLI for one Chorus thread. The CLI flags live in @chauvoluuhuong/chorus-core (docs/chorus-core.md); this
// file adds what is Chorus's own: its MCP server (`chorus mcp` bound to the thread) and the chat's start text.
import { isSea } from 'node:sea';
import path from 'node:path';
import { buildHeadless as coreHeadless, buildInteractive as coreInteractive, type Launch, type McpServer } from '@chauvoluuhuong/chorus-core';
import { MCP_INSTRUCTIONS, startText, TOOL_NAMES, type StartTextOpts } from '../mcp/server.ts';
import { TOOL_NAMES as SUB_TOOL_NAMES } from '../serve/subthreads.ts';
import type { AgentId } from './types.ts';

export { homes, run, SCRUB_ENV, SKIP_FLAG, writeAgyMcpConfig, writeAgyRules, type Launch, type RunResult } from '@chauvoluuhuong/chorus-core';

const CLI_ENTRY = path.resolve(import.meta.dirname, '../cli/index.ts');

export interface LaunchOpts {
  prompt: string;
  cwd: string;
  /** project dir that holds .chorus/ */
  project: string;
  threadId: string;
  resumeId?: string;
  model?: string;
  /** shared store folder, passed to the MCP server so it opens the same database */
  home?: string;
  /** the project's extra working folders (src/core/projects.ts): `--add-dir` at every start and resume */
  addDirs?: string[];
  /** the project's variables: the process environment only (Launch.env), never the command line */
  env?: Record<string, string>;
}

export interface InteractiveOpts {
  /** typed as the first message; omit to open an empty session */
  prompt?: string;
  cwd: string;
  project: string;
  threadId: string;
  /** native session id to continue (parked threads) */
  resumeId?: string;
  model?: string;
  /** shared store folder, passed to the MCP server so it opens the same database */
  home?: string;
  /** run without permission prompts (per chat, off by default; flags in docs/integrations/approvals.md) */
  skipPermissions?: boolean;
  /** reasoning effort (low … max); omitted = the agent's own default (docs/integrations/effort.md) */
  effort?: string;
  /** a teammate's chat: its role from the paid bundle (start text lines 3 to 6) */
  role?: StartTextOpts['role'];
  /** a sub thread: its main thread and the brief it gave (start text line 2b) */
  parent?: StartTextOpts['parent'];
  /** a plain chat: every action it may propose, when the bundle is there (start text line 4) */
  actionLabels?: string[];
  /** no edits and no writing commands */
  readOnly?: boolean;
  /** more chorus tools the agent may call without a prompt */
  moreTools?: string[];
  /** a sub thread or a step's Worker: the CLI's own question tool off where a per-session switch exists (Codex; not agy) */
  noNativeAsk?: boolean;
  /** what the chat's mail transport adds to this launch (chorus-core Transport.launch()): per-session flags, environment, files */
  wake?: { args?: string[]; env?: Record<string, string>; files?: Record<string, string> };
  /** the project's extra working folders (src/core/projects.ts): `--add-dir` at every start and resume */
  addDirs?: string[];
  /**
   * The chorus MCP server's own environment: the address and token of the serve that started the chat (task #14), so a second serve
   * that rewrites serve.json can't take it away. In Launch.env only, never on the command line (chorus-core McpServer.env).
   */
  mcpEnv?: Record<string, string>;
  /** the project's variables: the process environment only (Launch.env), never the command line */
  env?: Record<string, string>;
  /** the chat can get a folder added while it runs (chorus-core src/livedir.ts; Codex's default mode gets its per-session flag) */
  liveDirs?: boolean;
}

/**
 * A launch's own environment (Launch.env), for a start that only takes a command line: `env` sets it for this one process. Not used
 * for the chats' launches since task #11 (the Controller passes Launch.env to the PTY, so a project variable's value is never on a
 * command line); kept for tools that run a Launch as one command.
 */
export function withEnv(l: Launch): Launch {
  if (!l.env || !Object.keys(l.env).length) return l;
  const { env, ...rest } = l;
  return { ...rest, bin: '/usr/bin/env', args: [...Object.entries(env).map(([k, v]) => `${k}=${v}`), l.bin, ...l.args] };
}

/**
 * What a chat's system channel gets (approved 2026-11-17): the start text; Codex and agy also the chorus server's instructions after
 * it, because they don't show MCP instructions to the model. Claude reads those as MCP instructions.
 */
export function systemText(agent: AgentId, o: StartTextOpts): string {
  const text = startText(o);
  return agent === 'claude' ? text : `${text}\n\n${MCP_INSTRUCTIONS}`;
}

export function mcpCommand(project: string, threadId: string, home?: string) {
  // a single-executable build is its own entry point
  const entry = isSea() ? [] : [CLI_ENTRY];
  return { command: process.execPath, args: [...entry, 'mcp', '--project', project, '--thread', threadId, ...(home ? ['--home', home] : [])] };
}

// the sub thread tools are served by `chorus serve` through the bridge (src/mcp/pro.ts), and are Chorus's own: no prompt for them
const server = (o: { project: string; threadId: string; home?: string }): McpServer => ({ name: 'chorus', ...mcpCommand(o.project, o.threadId, o.home), tools: [...TOOL_NAMES, ...SUB_TOOL_NAMES] });

export function buildHeadless(agent: AgentId, o: LaunchOpts): Launch {
  return coreHeadless(agent, { prompt: o.prompt, cwd: o.cwd, resumeId: o.resumeId, model: o.model, mcp: server(o), instructions: systemText(agent, { threadId: o.threadId }), addDirs: o.addDirs, env: o.env });
}

/**
 * Command line that opens the agent's own screen with the Chorus MCP server attached for this thread.
 * Unlike headless runs there is no auto-approve flag: the agent asks and the user (or a Chorus card) answers.
 * Its environment (the mail transport's token, the project's variables) is in Launch.env, for the process only.
 */
export function buildInteractive(agent: AgentId, o: InteractiveOpts): Launch {
  return coreInteractive(agent, {
    prompt: o.prompt,
    cwd: o.cwd,
    resumeId: o.resumeId,
    model: o.model,
    effort: o.effort,
    skipPermissions: o.skipPermissions,
    mcp: { ...server(o), ...(o.moreTools ? { tools: [...server(o).tools, ...o.moreTools] } : {}), ...(o.mcpEnv ? { env: o.mcpEnv } : {}) },
    instructions: systemText(agent, { threadId: o.threadId, role: o.role, parent: o.parent, actionLabels: o.actionLabels }),
    readOnly: o.readOnly,
    // agy's rules file is one per folder, rewritten by every chat that starts there: a sub thread's "never ask" would reach a main
    // agy chat in the same folder, so agy is left out (its ask_question has no per-session switch)
    noNativeAsk: agent === 'agy' ? undefined : o.noNativeAsk,
    wake: o.wake,
    addDirs: o.addDirs,
    env: o.env,
    liveDirs: o.liveDirs,
  });
}
