// `chorus mcp --thread <id> [--project <dir>]`: stdio MCP server each AI CLI starts for its session.
// Stateless: every call reads the shared store (docs/architecture.md §6). All tools are read-only except request_approval and
// show_artifact, which only record a question or a file for the app that hosts the chat. The chat is the one whose CLI started this
// process (src/mcp/identity.ts), else --thread.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildHandoff, pickSourceThread } from '../core/handoff.ts';
import { knownSkills, readKnownSkill } from '../core/skillsync.ts';
import { Store, type ThreadRow } from '../core/store.ts';
import { ancestorPids, resolveThread } from './identity.ts';
import type { ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';
import { addProTools, listenChannel, proRole, serveInfo, type RoleInfo } from './pro.ts';
import { QUIET_MS, type MailMessage, type WatchState } from '@chauvoluuhuong/chorus-core';

export const TOOL_NAMES = ['get_handoff_context', 'get_thread_turns', 'list_threads', 'list_artifacts', 'list_skills', 'get_skill', 'request_approval', 'show_artifact', 'current_thread', 'read_mail', 'list_watches', 'get_project', 'propose_project_change', 'propose_new_project', 'reload_project_settings', 'rename_chat'] as const;

/** The project tools (task #11): free, answered in `chorus serve` (the project settings, the running chats and the cards live there). */
export const PROJECT_TOOL_NAMES = ['get_project', 'propose_project_change', 'propose_new_project', 'reload_project_settings', 'rename_chat'] as const;

/** Free tools `chorus serve` answers from its mailbox and watcher (task #10): `chorus mcp` passes them on through /api/pro/mcp/call. */
export const SERVE_TOOL_NAMES = ['read_mail', 'list_watches'] as const;

/** A chat's role in Chorus as the paid bundle gives it (chorus-core ThreadRole): tool-free texts, read live. */
export type ThreadRole = NonNullable<ReturnType<NonNullable<ProModule['roleOf']>>>;

/** Line (1) of every start text (approved 2026-11-17). */
export const CHORUS_LINE =
  'You are working inside Chorus, an app where the user works with several AI coding agents in one place. Chorus is your harness for this chat: when one of its MCP tools (server `chorus`) fits what you are about to do, use it before your own way of doing it, and follow the chorus server\'s instructions.';

/**
 * The chorus server's own instructions (approved 2026-11-17): how to work in Chorus. Claude reads them as MCP instructions; Codex and
 * agy don't show MCP instructions to the model, so launch.ts puts them after the start text there. Under 3 KB.
 */
export const MCP_INSTRUCTIONS = `How to work in Chorus:
- The user answers you in Chorus. When you need the user to approve, confirm or choose something before you go on, ask through Chorus as an approval card, never as a line in your reply. A Chorus task's plan is the exception: never ask the user to approve it; Chorus shows its Approve button once the plan is finished. Then tell the user in one line to open the task in Chorus to approve it, and never start the task or ask whether or how to start it: the user starts it in How to run.
- Show every file or link meant for the user through Chorus right after you make it.
- Work that can run on its own, or that the user wants another agent to do, goes to a sub thread. After starting one, go on with your work or end your turn; Chorus reports each time it ends a turn. Never check on it in a loop.
- When you need to see or manage your sub threads, or know your parent chat, task or step, look them up with current_thread.
- To start a new chat thread (not a sub thread): call list_teammates and list_actions, then ask the user in ONE approval card (kind question, your pick first) with the teammate and action options AND the new chat's permissions (Ask before acting, or Skip permissions; the teammate's own setting first), then call start_thread with the teammate, action and permissions the user chose; the new chat gets that teammate's agent, model and effort.
- Messages from other chats and from Chorus arrive in your Chorus mail; read them with read_mail when Chorus tells you that you have mail, and answer with the tool the message names.
- Chorus watches what you started (your action, your sub threads, your mail) and acts on it; see its watch records, their status and how long, with list_watches, instead of checking in a loop.
- Chorus actions (Create plan, Review changes, …): ask "Would you like me to <action>? <why>" with a question card; after the user's yes, start it with start_action; finish with action_done. Chorus watches each turn end and reminds you if it is missing.
- This project's working environment (its description, extra folders and environment variables) is in get_project. When it has no description, when get_project suggests folders, or when you need a folder outside the project or a variable, set it up with ONE propose_project_change call. Never ask the user to edit a CLI config or a shell profile, and never ask for a secret in the chat. To set up a NEW project, use propose_new_project (works from any chat, This computer too).
- Once you have a plan, or the chat's topic is clear, name this chat with rename_chat; a Planner also renames its task with task_update.
- A pasted 'Chorus thread <id> · …' line names another Chorus chat: read it with get_handoff_context or get_thread_turns.`;

const PROPOSE = 'ask the user first through a Chorus question card: "Would you like me to <action>? <one line why>", before any skill or workflow of your own; start the action through Chorus only after they say yes, and end it through Chorus when its work and check are finished.';
const KIND: Record<string, string> = { planner: 'Planner', worker: 'Worker', custom: 'Custom' };

export interface StartTextOpts {
  threadId: string;
  /** a sub thread's main thread: its id, its title and the brief it gave */
  parent?: { id: string; title: string; brief: string };
  /** a teammate's chat (the bundle's ThreadRole) */
  role?: ThreadRole;
  /** a plain chat: every action label, when the bundle is there */
  actionLabels?: string[];
}

/**
 * What every chat Chorus starts is told first, in its system channel (approved 2026-11-17): the Chorus line, the thread id, the sub
 * thread line, the role, the actions it may propose, what it is doing now and, for Planners, the project's goals. Each line only
 * when it exists; no line names a tool. Claude gets it as --append-system-prompt, Codex as developer instructions, agy as its rules
 * file (src/core/launch.ts).
 */
export function startText(o: StartTextOpts): string {
  const lines = [CHORUS_LINE, `This chat is Chorus thread ${o.threadId}.`];
  if (o.parent) {
    const first = (o.parent.brief.split('\n').find(l => l.trim()) ?? '').trim().replace(/[.:;,]+$/, '');
    lines.push(`This chat is a sub thread of Chorus thread ${o.parent.id} ("${o.parent.title}"), which started it to: ${first}. Your main thread is who you work for: when you need a decision, an approval or a fact before you can go on, ask your main thread through Chorus and end your turn, never the user. When your work is done, say so in your reply and end your turn: Chorus reports it to your main thread.`);
  }
  const r = o.role;
  if (r) lines.push(`Your role: ${KIND[r.teammate.kind] ?? r.teammate.kind} (teammate "${r.teammate.name}"). Its instructions:\n${r.instructions}`);
  if (!o.parent) {
    if (r) {
      if (r.teammate.kind !== 'worker' && r.actions.length) lines.push(`Your actions: ${r.actions.join(', ')}. When one of them fits what the user wants better than what you are doing, ${PROPOSE}`);
    } else if (o.actionLabels?.length) {
      lines.push(`Chorus actions: ${o.actionLabels.join(', ')}. When one of them fits what the user wants better than what you are doing (for example Create plan for work to be built in steps, Review changes for finished work), ${PROPOSE}`);
    }
  }
  if (r?.action) lines.push(`Your action: ${r.action.text}`);
  if (r?.goals.length) {
    lines.push(`Active goals of this project:\n${r.goals.map(g => `- ${g.title} (id ${g.id}). Done when: ${g.doneWhen}`).join('\n')}`);
  }
  return lines.join('\n\n');
}

export function createServer(project: string, threadId?: string, home?: string, o: { role?: (home: string, threadId: string) => Promise<RoleInfo | undefined> } = {}): McpServer & { addProTools(): Promise<void> } {
  const store = new Store(project, { home });
  // how to work in Chorus: Claude reads it here; Codex and agy get it in their start text (launch.ts). An AI app with no chat gets none
  const instructions = threadId ? MCP_INSTRUCTIONS : undefined;
  // a chat's server can push Chorus messages to Claude Code (its mail transport: `notifications/claude/channel`, claude-code.md §15);
  // the CLI reads the capability only when launched with its channels flag
  const server = new McpServer({ name: 'chorus', version: '1.0.0' }, { ...(instructions ? { instructions } : {}), ...(threadId ? { capabilities: { experimental: { 'claude/channel': {} } } } : {}) }) as McpServer & { addProTools(): Promise<void> };

  // the role lives in the paid bundle, which runs in `chorus serve`: asked once per call, never cached (it changes as a task moves)
  const role = (): Promise<RoleInfo | undefined> => (threadId ? (o.role ?? proRole)(store.root, threadId) : Promise.resolve(undefined));

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

  // every skill Chorus has seen (Sync skills: the CLIs' folders, the user's sources, this project's library)
  server.registerTool('list_skills', { description: 'Chorus skills (name and when to use).', inputSchema: {} }, async () =>
    reply('list_skills', knownSkills(store, project).map(s => `${s.name}: ${s.description}`).join('\n') || '(none)'),
  );

  server.registerTool(
    'get_skill',
    { description: 'Full SKILL.md text of a Chorus skill; follow it as instructions.', inputSchema: { name: z.string() } },
    async ({ name }) => {
      const body = readKnownSkill(store, project, name);
      return body ? reply('get_skill', body) : reply('get_skill', `Unknown skill ${name}`, true);
    },
  );

  server.registerTool(
    'request_approval',
    {
      description:
        "The way to get the user's approval, confirmation or choice in this chat: use it instead of asking in your reply whenever you need the user's OK on a risky or irreversible change, or a choice between options. Not for a Chorus task's plan: Chorus shows the user that plan's Approve button once the plan is finished; never ask for it here. A sub thread asks its main thread instead. Chorus shows it as a card with your options wherever the user is. Returns at once: end your turn after calling it. The user's answer arrives as their next message, starting with \"Chorus approval <id>:\" and the option they chose, or \"Other: <their own words>\" when none of your options fit (and maybe a note). The details may use Markdown (short paragraphs, - lists, **bold**, `code`).",
      inputSchema: {
        question: z.string().min(1).describe('What you ask, in one sentence (e.g. "Apply the migration plan to the production database?")'),
        details: z.string().optional().describe('A short summary the user needs to decide: the plan, the command, what changes (a few lines; the full plan can be an artifact)'),
        options: z.array(z.string().min(1)).min(2).max(5).optional().describe('The answers to offer, the one you suggest first. Default: ["Approve", "Decline"]'),
        kind: z.enum(['question', 'approval']).optional().describe('"approval" (the default): the user approves or declines an action you want to take. "question": you need a choice or a fact from the user; they may also skip it, and then you decide yourself.'),
        other: z.boolean().optional().describe('false when only the listed options make sense: the card then has no "Other…" for an answer of the user\'s own. Default true.'),
      },
    },
    async ({ question, details, options, kind, other }) => {
      if (!threadId) return reply('request_approval', 'This chat is not a Chorus thread: ask the user in your reply.', true);
      if (isSubThread(store.getThread(threadId))) return reply('request_approval', SUB_REFUSAL, true);
      if ((store.getThread(threadId)?.sub_status as string) === 'task') return reply('request_approval', WORKER_REFUSAL, true);
      if (planGuard((await role())?.role, kind, question)) return reply('request_approval', PLAN_REFUSAL, true);
      const r = store.createRequest({ threadId, question, details, options, kind, other });
      const skip = r.kind === 'question' ? ' If they skip it, the message is "Chorus approval <id>: skipped. Decide yourself and say what you chose.": then decide yourself, say what you chose, and go on.' : '';
      return reply('request_approval', `Shown to the user as approval card ${r.id} with the options: ${r.options.join(' / ')}. End your turn now without asking again in your reply. Their answer arrives as their next message: "Chorus approval ${r.id}: <option>"${r.other ? ', or "Other: <their own words>" when none fit' : ''}.${skip}`);
    },
  );

  server.registerTool(
    'show_artifact',
    {
      description:
        'Show the user a file you made for them (or a link): it is listed in the chat\'s Artifacts view in Chorus, where they open it. Use it for every file or link meant for the user (a note, plan, report, mockup, export: not the project\'s source code), right after you create it, wherever you saved it. A path can be absolute or relative to your working folder; the file must exist. A link must be http or https.',
      inputSchema: {
        target: z.string().min(1).describe('The file\'s path, or an http(s) link'),
        title: z.string().optional().describe('A short title for the list (e.g. "Export button mockup"); default: the file name'),
      },
    },
    async ({ target, title }) => {
      if (!threadId) return reply('show_artifact', 'This chat is not a Chorus thread: give the user the path in your reply.', true);
      const t = target.trim();
      if (/^https?:\/\//i.test(t)) {
        store.reportArtifact(threadId, t, title);
        return reply('show_artifact', `Listed in Artifacts: ${title?.trim() || t}`);
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return reply('show_artifact', 'Only a file path or an http(s) link can be shown.', true);
      const cwd = store.getThread(threadId)?.cwd ?? project;
      const abs = path.resolve(cwd, t.replace(/^~(?=\/)/, os.homedir()));
      let file = false;
      try {
        file = fs.statSync(abs).isFile();
      } catch {
        /* missing */
      }
      if (!file) return reply('show_artifact', `There is no file at ${abs}. Save it first, then call show_artifact again.`, true);
      store.reportArtifact(threadId, abs, title);
      return reply('show_artifact', `Listed in Artifacts: ${title?.trim() || path.basename(abs)} (${abs})`);
    },
  );

  // read_mail and list_watches: chorus serve holds the mailbox and the watcher, so the call goes there (the route the paid tools use)
  const viaServe = async (tool: string, args: Record<string, unknown>) => {
    if (!threadId) return reply(tool, 'This chat is not a Chorus thread.', true);
    const info = serveInfo(store.root);
    if (!info) return reply(tool, 'Chorus is not running, so this tool is not available right now.', true);
    try {
      const r = await fetch(`${info.url}/api/pro/mcp/call`, { method: 'POST', headers: { authorization: `Bearer ${info.mcpToken}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ name: tool, args, threadId }), signal: AbortSignal.timeout(10_000) });
      const j = (await r.json()) as { text?: string; error?: string };
      return r.ok ? reply(tool, j.text ?? '') : reply(tool, j.error ?? 'This tool is not available right now.', true);
    } catch {
      return reply(tool, 'Chorus is not running, so this tool is not available right now.', true);
    }
  };

  server.registerTool(
    'read_mail',
    {
      description: 'Your Chorus messages (reports, questions, answers, reminders) from other chats and from Chorus. Without an id: the unread ones, which are then marked read. With an id: that message in full.',
      inputSchema: { id: z.string().optional().describe('A message id, to read that one message'), all: z.boolean().optional().describe('true: the read ones too (newest 20)') },
    },
    async ({ id, all }) => viaServe('read_mail', { id, all }),
  );

  server.registerTool(
    'list_watches',
    {
      description: 'The watch records Chorus keeps for this chat: what it expects, on which chat, its status and for how long, and what fires next. Use it instead of checking chats yourself.',
      inputSchema: { key: z.string().optional().describe('A record\'s key, for that record in full with its last events'), ended: z.boolean().optional().describe('true: also the records ended in the last 24 hours') },
    },
    async ({ key, ended }) => viaServe('list_watches', { key, ended }),
  );

  server.registerTool(
    'get_project',
    {
      description:
        "This chat's own project: its folder and description, the extra working folders and environment variable NAMES every chat in it gets (each with why and who added it, and whether this chat has it yet), folders it probably needs (suggested_folders), its chats, tasks and artifacts. Never a variable's value. Call it before working outside the project folder, when you need a variable, and before propose_project_change.",
      inputSchema: {},
    },
    async () => viaServe('get_project', {}),
  );

  server.registerTool(
    'propose_project_change',
    {
      description:
        "Set up or change this project's working environment, all on ONE card the user approves: its description (set_note: what the project is and how its folders relate, for every later chat), the extra folders its chats need (add_folder for an existing folder, e.g. one from get_project's suggested_folders; create_folder for a new one: its parent must exist), and the environment variables they need (set_variable: you give only the NAME and why; the user types the value). Call get_project first. Nothing changes until the user approves. Returns at once: end your turn; the answer arrives as your next message and never contains a value.",
      inputSchema: {
        changes: z
          .array(
            z.object({
              kind: z.enum(['set_note', 'add_folder', 'create_folder', 'remove_folder', 'set_variable', 'remove_variable']),
              path: z.string().optional().describe('add_folder, create_folder, remove_folder: the folder\'s absolute path'),
              name: z.string().optional().describe('set_variable, remove_variable: the variable\'s name, like POLAR_TOKEN'),
              note: z.string().optional().describe('set_note: the description'),
              why: z.string().min(1).describe('One line: what this change is for. Kept with it, so later chats see it'),
              suggested_value: z.string().optional().describe('set_variable only: a value that is NOT secret (a URL, a mode); never a token or a password'),
            }),
          )
          .min(1)
          .max(15),
        reason: z.string().optional().describe('One or two lines on the whole proposal, shown at the top of the card'),
      },
    },
    async ({ changes, reason }) => viaServe('propose_project_change', { changes, reason }),
  );

  server.registerTool(
    'propose_new_project',
    {
      description:
        "Create a NEW Chorus project for the user, from any chat (including This computer): its main folder (existing, or a new one with create), its description, the extra folders its chats need and the environment variables they need (names only; the user types values). Use it when the user asks you to set up or start a project; use propose_project_change to change the project your chat is already in. One card; nothing happens until the user approves.",
      inputSchema: {
        folder: z.string().min(1).describe("The project's main folder: an absolute path"),
        create: z.boolean().optional().describe('Make the main folder (it must not exist; its parent must)'),
        note: z.string().min(1).describe('The description: what the project is and how its folders relate, for every later chat'),
        folders: z
          .array(z.object({ path: z.string().min(1).describe('An absolute path'), why: z.string().min(1).describe('One line: what it is for'), create: z.boolean().optional().describe('Make this folder (its parent must exist)') }))
          .max(12)
          .optional(),
        variables: z
          .array(z.object({ name: z.string().min(1).describe('Like API_TOKEN'), why: z.string().min(1).describe('One line: what it is for'), suggested_value: z.string().optional().describe('Only a value that is NOT secret; never a token or a password') }))
          .max(12)
          .optional(),
        why: z.string().min(1).describe('One or two lines: why the user wants this project, shown at the top of the card'),
      },
    },
    async ({ folder, create, note, folders, variables, why }) => viaServe('propose_new_project', { folder, create, note, folders, variables, why }),
  );

  server.registerTool(
    'reload_project_settings',
    {
      description:
        "Restart this chat when its current turn ends, conversation kept, so it gets the project's current working folders and variables (get_project's this_chat.missing lists what it lacks). Finish your turn after calling it.",
      inputSchema: {},
    },
    async () => viaServe('reload_project_settings', {}),
  );

  server.registerTool(
    'rename_chat',
    {
      description:
        "Give this chat a short name that says what it is about (e.g. 'Plan: Projects page'). Call it once you have a plan or the chat's topic is clear, and again when the topic changes. A Planner also gives its task the same name with task_update. Only this chat; the user can undo it.",
      inputSchema: { title: z.string().min(1).max(60).describe('The new name: one line, at most 60 characters') },
    },
    async ({ title }) => viaServe('rename_chat', { title }),
  );

  server.registerTool(
    'current_thread',
    {
      description:
        "This chat's own context: its id, agent and settings, its parent and sub threads, its role and action, and its task and step. Use it when you need to see or manage your sub threads or know any of these.",
      inputSchema: {},
    },
    async () => {
      const t = threadId ? store.getThread(threadId) : undefined;
      if (!t) return reply('current_thread', 'This chat is not a Chorus thread.', true);
      return reply('current_thread', JSON.stringify(currentThread(store, t, await role()), null, 1));
    },
  );

  server.addProTools = () => addProTools(server, store.root, threadId, reply);
  return server;
}

/**
 * `chorus mcp`: the chat this server belongs to is the one whose CLI started it (an ancestor process), else --thread. agy starts its
 * server lazily from a config every agy chat in a folder shares, so --thread can name another chat there (probe D, chorus-core 56b00d9).
 */
export async function runMcp(project: string, threadId?: string, home?: string) {
  const store = new Store(project, { home });
  let id = threadId;
  try {
    id = resolveThread(store, threadId, ancestorPids(process.pid));
  } finally {
    store.close();
  }
  const server = createServer(project, id, home);
  await server.addProTools();
  await server.connect(new StdioServerTransport());
  // a Claude chat gets its Chorus mail through this connection (src/serve/mail.ts); Codex and agy get theirs from their own CLI
  const row = id ? new Store(project, { home }) : undefined;
  const agent = id ? row?.getThread(id)?.agent : undefined;
  const root = row?.root;
  row?.close();
  if (id && agent === 'claude' && root) {
    const stop = listenChannel(root, id, params => server.server.notification({ method: 'notifications/claude/channel', params }));
    const end = () => {
      stop();
      process.exit(0);
    };
    process.stdin.once('end', end);
    process.stdin.once('close', end);
    server.server.onclose = end;
  }
}

/* ---------- current_thread, the request_approval guards ---------- */

/** A sub thread a chat started with start_subthread; a task step's Worker ('task') asks its Planner instead. */
export const isSubThread = (t: ThreadRow | undefined) => !!t?.sub_status && (t.sub_status as string) !== 'task';

export const SUB_REFUSAL = 'You are a sub thread: ask your main thread instead (ask_main_thread), not the user.';
export const WORKER_REFUSAL = "You are a task step's Worker: ask your Planner with ask_planner, not the user.";
export const PLAN_REFUSAL =
  "Chorus asks the user to approve this task's plan itself. Finish the plan the way your role says: that turns on its Approve button. Ask here only for facts or choices you need to write the plan.";

/** A chat writing a task's plan never asks the user to approve it: Chorus does, once the plan is finished. */
export function planGuard(role: ThreadRole | null | undefined, kind: 'question' | 'approval' | undefined, question: string): boolean {
  if (role?.action?.id !== 'createPlan' || role.task?.state !== 'planning') return false;
  return (kind ?? 'approval') === 'approval' || (/approv/i.test(question) && /\bplan\b/i.test(question));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** What current_thread returns: the chat as Chorus has it now. */
export function currentThread(store: Store, t: ThreadRow, info: RoleInfo | undefined) {
  const parent = t.parent_thread_id ? store.getThread(t.parent_thread_id) : undefined;
  const sub = isSubThread(t);
  const reported = store.reportedArtifacts(t.id);
  const latest = reported[0];
  return {
    thread: {
      id: t.id,
      title: t.title,
      agent: t.agent,
      model: t.model,
      effort: t.effort,
      cli_version: t.cli_version,
      permissions: info?.readOnly ? 'read-only' : t.skip_permissions ? 'skip' : 'prompts',
      state: t.state,
      project: t.project,
      cwd: t.cwd,
      created: t.created,
    },
    parent: parent ? { id: parent.id, title: parent.title, agent: parent.agent, asked: t.sub_brief ?? null } : null,
    sub_threads: store.subThreads(t.id).map(s => ({ id: s.id, title: s.title, agent: s.agent, status: (s.sub_status as string) === 'task' ? 'task step' : s.sub_status, turns: s.sub_turns ?? 0, last_reply: clip(store.lastReply(s.id).replace(/\s+/g, ' ').trim(), 200) })),
    role: info?.role ?? null,
    artifacts: { count: reported.length, latest: latest ? { target: latest.target, title: latest.title, ts: latest.ts } : null },
    open_requests: store.pendingRequests(t.id).map(r => ({ id: r.id, kind: r.kind, question: r.question, options: r.options, created: r.created })),
    open_questions: (sub ? store.openAsks({ thread: t.id }) : store.openAsks({ parent: t.id })).map(a => ({ id: a.id, from: a.thread_id, to: a.parent_id, kind: a.kind, question: a.question, details: a.details, options: a.options, asked: a.created })),
  };
}

/* ---------- read_mail and list_watches (answered in chorus serve) ---------- */

/** A duration as people say it: "45s", "3m 20s", "1h 05m". */
export function human(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`.replace(/ 00s$/, '');
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function mailText(m: MailMessage): string {
  const f = m.from;
  const who = f.who === 'chorus' && !f.thread ? 'Chorus' : `thread ${f.thread ?? '?'}`;
  const extra = [f.teammate && `teammate "${f.teammate}"`, f.role].filter(Boolean).join(', ');
  const refs = Object.entries(m.refs ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
  return [`### ${m.id} · ${m.kind}`, `From: ${who}${extra ? ` (${extra})` : ''}`, `Subject: ${m.subject}`, ...(refs ? [`Refs: ${refs}`] : []), '', m.body].join('\n');
}

/** read_mail: the unread messages (marked read), one by id, or with `all` the newest 20 whatever their state. */
export function readMailText(mail: { read(thread: string, id?: string): MailMessage[]; list(q: { to?: string }): MailMessage[] }, thread: string, args: { id?: string; all?: boolean }): { text: string; isError?: boolean } {
  if (args.id) {
    const [m] = mail.read(thread, args.id);
    return m ? { text: mailText(m) } : { text: `No message ${args.id} for this chat.`, isError: true };
  }
  const unread = mail.read(thread);
  const msgs = args.all ? mail.list({ to: thread }).slice(-20).reverse() : unread;
  if (!msgs.length) return { text: args.all ? 'No messages for this chat.' : 'No unread messages.' };
  return { text: msgs.map(mailText).join('\n\n---\n\n') };
}

const DAY = 86_400_000;

/** What a watch fires next and in how long, from its deadline (or the quiet check while it works). */
function nextOf(w: WatchState, now: number): string {
  if (w.ended_at) return '—';
  const missed = Number(w.data?.missed ?? 0);
  const label = w.kind === 'action' ? (missed >= 1 ? 'Stopped card' : 'reminder') : w.kind === 'mail' ? 'reminder' : 'idle check';
  const options: [number, string][] = [];
  if (w.deadline) options.push([w.deadline, label]);
  if (w.seen === 'working' && !w.quietSent && !w.waitsOn?.includes('card')) options.push([(w.activityAt ?? w.since ?? now) + QUIET_MS, w.kind === 'thread' ? '"may be stuck"' : 'quiet check']);
  if (!options.length) return '—';
  const [at, what] = options.sort((a, b) => a[0] - b[0])[0];
  return `${what} in ${human(at - now)}`;
}

function statusOf(w: WatchState): string {
  if (w.ended_at || w.seen === 'ended') return 'ended';
  if (w.waitsOn?.length) return `waiting on ${w.waitsOn.join(', ')}`;
  if (w.seen === 'working') return 'working';
  if (w.seen === 'waiting') return 'idle';
  return 'not seen yet';
}

/** list_watches: the records kept for `thread` (watch.belongs_to), live state from the watcher; one in full with its events by key. */
export function listWatchesText(o: { store: Pick<Store, 'getThread' | 'endedWatches' | 'watchEvents' | 'watchRecord'>; watch: { get(key: string): WatchState | undefined; list(q: { belongsTo?: string }): WatchState[] }; thread: string; now: number }, args: { key?: string; ended?: boolean }): { text: string; isError?: boolean } {
  const { store, thread, now } = o;
  const live = (w: WatchState) => o.watch.get(w.key) ?? w;
  const chat = (id: string) => (id === thread ? 'this chat' : `${id} ${store.getThread(id)?.title ?? ''}`.trim());
  const last = (key: string) => {
    const e = store.watchEvents({ key }).at(-1);
    return e ? `${e.type} ${human(now - e.at)} ago → ${e.action ?? '—'}` : '—';
  };
  const fields = (w: WatchState) => ({
    key: w.key,
    kind: w.kind,
    chat: chat(w.thread),
    expects: w.expect,
    status: statusOf(w),
    for: w.since !== undefined ? human((w.ended_at ?? now) - w.since) : '—',
    open: human((w.ended_at ?? now) - w.created_at),
    missed: String(Number(w.data?.missed ?? 0)),
    next: nextOf(w, now),
    last: last(w.key),
  });
  if (args.key) {
    const rec = o.watch.get(args.key) ?? store.watchRecord(args.key);
    if (!rec || rec.belongsTo !== thread) return { text: `No watch record ${args.key} for this chat.`, isError: true };
    const f = fields(live(rec));
    const events = store.watchEvents({ key: args.key }).slice(-20).reverse();
    return {
      text: [
        `- key: ${f.key}`, `- kind: ${f.kind}`, `- watched chat: ${f.chat}`, `- expects: ${f.expects}`, `- status: ${f.status}`, `- for: ${f.for}`,
        `- open for: ${f.open}`, `- missed: ${f.missed}`, `- next: ${f.next}`, `- last event: ${f.last}`, '',
        'Last events (newest first):',
        ...(events.length ? events.map(e => `- ${new Date(e.at).toISOString()} ${e.type}${e.detail !== undefined ? ` ${JSON.stringify(e.detail)}` : ''} → ${e.action ?? '—'}`) : ['- none']),
      ].join('\n'),
    };
  }
  const open = o.watch.list({ belongsTo: thread }).map(live);
  const ended = args.ended ? store.endedWatches(thread, now - DAY, 20).filter(w => !open.some(x => x.key === w.key)) : [];
  const rows = [...open, ...ended].sort((a, b) => a.created_at - b.created_at);
  if (!rows.length) return { text: 'No watch records for this chat.' };
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return {
    text: [
      '| key | kind | watched chat | expects | status | for | open for | missed | next | last event |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...rows.map(fields).map(f => `| ${[f.key, f.kind, f.chat, f.expects, f.status, f.for, f.open, f.missed, f.next, f.last].map(cell).join(' | ')} |`),
    ].join('\n'),
  };
}
