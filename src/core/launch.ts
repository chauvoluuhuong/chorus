// How to start each CLI for one Chorus thread. The CLI flags live in @chauvoluuhuong/chorus-core (docs/chorus-core.md); this
// file adds what is Chorus's own: its MCP server (`chorus mcp` bound to the thread) and the standing note for the chat.
import { isSea } from 'node:sea';
import path from 'node:path';
import { buildHeadless as coreHeadless, buildInteractive as coreInteractive, type Launch, type McpServer } from '@chauvoluuhuong/chorus-core';
import { APPROVAL_NOTE, TOOL_NAMES } from '../mcp/server.ts';
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
}

/** Where a thread's artifacts go, said to the agent (architecture §9). Claude and agy also get it through the MCP server's instructions. */
export function artifactNote(project: string, threadId: string): string {
  return `This chat is Chorus thread ${threadId}. Files meant for the user (notes, plans, reports, mockups, anything that is not source code of the project) go in ${path.join(project, '.chorus', 'threads', threadId, 'artifacts')} (create it if missing). Chorus shows them in its Artifacts view. ${APPROVAL_NOTE}`;
}

export function mcpCommand(project: string, threadId: string, home?: string) {
  // a single-executable build is its own entry point
  const entry = isSea() ? [] : [CLI_ENTRY];
  return { command: process.execPath, args: [...entry, 'mcp', '--project', project, '--thread', threadId, ...(home ? ['--home', home] : [])] };
}

const server = (o: { project: string; threadId: string; home?: string }): McpServer => ({ name: 'chorus', ...mcpCommand(o.project, o.threadId, o.home), tools: [...TOOL_NAMES] });

export function buildHeadless(agent: AgentId, o: LaunchOpts): Launch {
  return coreHeadless(agent, { prompt: o.prompt, cwd: o.cwd, resumeId: o.resumeId, model: o.model, mcp: server(o), instructions: artifactNote(o.project, o.threadId) });
}

/**
 * Command line that opens the agent's own screen with the Chorus MCP server attached for this thread.
 * Unlike headless runs there is no auto-approve flag: the agent asks and the user (or a Chorus card) answers.
 */
export function buildInteractive(agent: AgentId, o: InteractiveOpts): Launch {
  return coreInteractive(agent, {
    prompt: o.prompt,
    cwd: o.cwd,
    resumeId: o.resumeId,
    model: o.model,
    effort: o.effort,
    skipPermissions: o.skipPermissions,
    mcp: server(o),
    instructions: artifactNote(o.project, o.threadId),
  });
}
