// `chorus mcp --thread <id> [--project <dir>]`: stdio MCP server each AI CLI starts for its session.
// Stateless: every call reads the shared store (docs/architecture.md §6). All tools are read-only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildHandoff, pickSourceThread } from '../core/handoff.ts';
import { listSkills, readSkill } from '../core/skills.ts';
import { Store } from '../core/store.ts';

export const TOOL_NAMES = ['get_handoff_context', 'get_thread_turns', 'list_threads', 'list_artifacts', 'list_skills', 'get_skill'] as const;

export function createServer(project: string, threadId?: string, home?: string): McpServer {
  const store = new Store(project, { home });
  // Every agent starts this server for its thread, so this text reaches all three: it says where the thread's artifacts go.
  const dir = threadId ? store.artifactsDir(threadId) : undefined;
  const instructions = dir
    ? `This chat is Chorus thread ${threadId}. Files meant for the user (notes, plans, reports, mockups, anything that is not source code of the project) go in ${dir} (create it if missing). Chorus shows them in its Artifacts view.`
    : undefined;
  const server = new McpServer({ name: 'chorus', version: '0.0.1' }, instructions ? { instructions } : undefined);

  const reply = (tool: string, text: string, isError = false) => {
    try {
      store.logMcpCall(threadId, tool);
    } catch {
      /* logging must never break a tool call */
    }
    return { content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) };
  };

  server.registerTool(
    'get_handoff_context',
    {
      description:
        'Compact digest of the Chorus thread this chat continues (first request, files touched, commands, test results, artifacts, recent turns, last assistant message). Call this first when the user says this chat continues another Chorus thread.',
      inputSchema: { thread_id: z.string().optional().describe('Only to load some other chat: its id as listed by list_threads (like t_ab12cd34). Leave it out to load the chat this one continues.') },
    },
    async ({ thread_id }) => {
      const src = pickSourceThread(store, threadId, thread_id);
      if (!src) return reply('get_handoff_context', 'No other Chorus thread found in this project.', true);
      return reply('get_handoff_context', buildHandoff(store, src).text);
    },
  );

  server.registerTool(
    'get_thread_turns',
    {
      description: 'Older conversation turns of a thread, newest last. Page backwards with `before` (a turn seq).',
      inputSchema: { thread_id: z.string(), before: z.number().int().optional(), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ thread_id, before, limit }) => {
      if (!store.getThread(thread_id)) return reply('get_thread_turns', `Unknown thread ${thread_id}`, true);
      const turns = store.getTurns(thread_id, { before, limit: limit ?? 10 });
      return reply('get_thread_turns', turns.map(t => `[${t.seq}] ${t.role}: ${t.text}`).join('\n\n') || '(no turns)');
    },
  );

  server.registerTool('list_threads', { description: 'Chorus threads (all projects). Pass an id to get_handoff_context to continue one.', inputSchema: {} }, async () =>
    reply(
      'list_threads',
      store
        .listThreads()
        .map(t => `${t.id}\t${t.agent}\t${t.state}\t${t.title}\t${t.project ?? ''}${t.id === threadId ? '\t(this thread)' : ''}`)
        .join('\n') || '(none)',
    ),
  );

  server.registerTool(
    'list_artifacts',
    { description: 'Files agents produced (paths to read with your own file tools).', inputSchema: { thread_id: z.string().optional() } },
    async ({ thread_id }) =>
      reply('list_artifacts', store.listArtifacts(thread_id).map(a => `${a.thread_id}\t${a.abs}\t${a.version}`).join('\n') || '(none)'),
  );

  server.registerTool('list_skills', { description: 'Chorus skills for this project (name and when to use).', inputSchema: {} }, async () =>
    reply('list_skills', listSkills(project).map(s => `${s.name}: ${s.description}`).join('\n') || '(none)'),
  );

  server.registerTool(
    'get_skill',
    { description: 'Full SKILL.md text of a Chorus skill; follow it as instructions.', inputSchema: { name: z.string() } },
    async ({ name }) => {
      const r = readSkill(project, name);
      return r ? reply('get_skill', r.body) : reply('get_skill', `Unknown skill ${name}`, true);
    },
  );

  return server;
}

export async function runMcp(project: string, threadId?: string, home?: string) {
  const server = createServer(project, threadId, home);
  await server.connect(new StdioServerTransport());
}
