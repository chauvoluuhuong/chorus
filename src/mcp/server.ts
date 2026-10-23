// `chorus mcp --thread <id> [--project <dir>]`: stdio MCP server each AI CLI starts for its session.
// Stateless: every call reads the shared store (docs/architecture.md §6). All tools are read-only except request_approval,
// which only records a question for the app that hosts the chat.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildHandoff, pickSourceThread } from '../core/handoff.ts';
import { listSkills, readSkill } from '../core/skills.ts';
import { Store } from '../core/store.ts';

export const TOOL_NAMES = ['get_handoff_context', 'get_thread_turns', 'list_threads', 'list_artifacts', 'list_skills', 'get_skill', 'request_approval'] as const;

/**
 * Said to every agent at start (MCP server instructions for Claude and agy, developer instructions for Codex): an approval the
 * agent wants from the user goes through Chorus, where it is a card the user answers from any chat, instead of a line in the
 * reply (agy's "click Proceed", Codex's "reply Approve") that Chorus cannot see.
 */
export const APPROVAL_NOTE =
  'The user answers you in Chorus. Whenever you would ask the user to approve, confirm or choose something before you go on (a plan, a risky or irreversible change, a choice between options, "click Proceed", "reply Approve"), do not ask in your reply: call the chorus MCP tool request_approval with the question, a short summary and the options, then end your turn. Chorus shows it to the user as an approval card and their answer arrives as their next message. Your own permission prompts for commands and edits stay as they are.';

export function createServer(project: string, threadId?: string, home?: string): McpServer {
  const store = new Store(project, { home });
  // Every agent starts this server for its thread, so this text reaches all three: it says where the thread's artifacts go.
  const dir = threadId ? store.artifactsDir(threadId) : undefined;
  const instructions = dir
    ? `This chat is Chorus thread ${threadId}. Files meant for the user (notes, plans, reports, mockups, anything that is not source code of the project) go in ${dir} (create it if missing). Chorus shows them in its Artifacts view. ${APPROVAL_NOTE}`
    : undefined;
  const server = new McpServer({ name: 'chorus', version: '1.0.0' }, instructions ? { instructions } : undefined);

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

  server.registerTool(
    'request_approval',
    {
      description:
        "The way to get the user's approval, confirmation or choice in this chat: use it instead of asking in your reply whenever you need the user's OK on a plan, a risky or irreversible change, or a choice between options. Chorus shows it as a card with your options wherever the user is. Returns at once: end your turn after calling it. The user's answer arrives as their next message, starting with \"Chorus approval <id>:\" and the option they chose, or \"Other: <their own words>\" when none of your options fit (and maybe a note).",
      inputSchema: {
        question: z.string().min(1).describe('What you ask, in one sentence (e.g. "Apply the migration plan to the production database?")'),
        details: z.string().optional().describe('A short summary the user needs to decide: the plan, the command, what changes (a few lines; the full plan can be an artifact)'),
        options: z.array(z.string().min(1)).min(2).max(5).optional().describe('The answers to offer, the one you suggest first. Default: ["Approve", "Decline"]'),
      },
    },
    async ({ question, details, options }) => {
      if (!threadId) return reply('request_approval', 'This chat is not a Chorus thread: ask the user in your reply.', true);
      const r = store.createRequest({ threadId, question, details, options });
      return reply('request_approval', `Shown to the user as approval card ${r.id} with the options: ${r.options.join(' / ')}. End your turn now without asking again in your reply. Their answer arrives as their next message: "Chorus approval ${r.id}: <option>", or "Other: <their own words>" when none fit.`);
    },
  );

  return server;
}

export async function runMcp(project: string, threadId?: string, home?: string) {
  const server = createServer(project, threadId, home);
  await server.connect(new StdioServerTransport());
}
