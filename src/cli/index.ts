#!/usr/bin/env node
// chorus: the CLI app (Phase 4) and its plain commands. `chorus mcp` is started by the agents, not by you.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { App } from '../app/app.ts';
import { AGENTS, Controller } from '../app/controller.ts';
import { PreviewServer } from '../core/preview.ts';
import { Store } from '../core/store.ts';
import type { AgentId } from '../core/types.ts';
import { disabledSkills, findNativeSkills, importSkill, listSkills, setSkillEnabled, syncSkills } from '../core/skills.ts';
import { runMcp } from '../mcp/server.ts';
import { activityCmd, artifactsCmd, doctorCmd, memoryCmd, showCmd, threadsCmd, traceCmd } from './commands.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const project = path.resolve(flag('project') ?? process.cwd());
const asAgent = (s?: string): AgentId | undefined => (AGENTS.includes(s as AgentId) ? (s as AgentId) : undefined);
const models = (): Partial<Record<AgentId, string>> => ({ claude: process.env.CHORUS_MODEL_CLAUDE, codex: process.env.CHORUS_MODEL_CODEX, agy: process.env.CHORUS_MODEL_AGY });

/**
 * One database for every project (~/.chorus/chorus.db) unless CHORUS_STORE=project keeps it in <project>/.chorus. The folder is
 * passed to the agents' MCP servers explicitly, so they open the same file.
 */
function openStore() {
  const home = process.env.CHORUS_HOME ?? (process.env.CHORUS_STORE === 'project' ? undefined : path.join(process.env.HOME ?? '.', '.chorus'));
  const store = new Store(project, { home });
  store.importLocal(project); // chats recorded before the store was shared
  return store;
}

/**
 * Ask the terminal for a comfortable window (CHORUS_SIZE=COLSxROWS, default 130x36) when it is smaller; it never shrinks one.
 * Terminals that do not allow resizing from a program (many ignore it) just keep their size and the layout steps down.
 */
function wantSize() {
  if (!process.stdout.isTTY || process.env.CHORUS_SIZE === 'off') return;
  const [wc, wr] = (process.env.CHORUS_SIZE ?? '130x36').split('x').map(Number);
  const cols = Math.max(process.stdout.columns || 0, wc || 0);
  const rows = Math.max(process.stdout.rows || 0, wr || 0);
  if (cols !== process.stdout.columns || rows !== process.stdout.rows) process.stdout.write(`\x1b[8;${rows};${cols}t`);
}

async function app(start: (c: Controller) => Promise<void> | void, opts: { newChat?: boolean } = {}) {
  const store = openStore();
  const ui = new App();
  const c = new Controller({ project, store, app: ui, models: models() });
  c.restore();
  await start(c);
  // `chorus` alone opens New chat (the first screen); new/run/handoff go straight to a chat
  if (opts.newChat && !ui.current?.host) c.newChatScreen();
  wantSize();
  ui.start();
  await ui.done;
  store.close();
  process.exit(0);
}

const cmd = argv[0];
switch (cmd) {
  case undefined:
  case 'app':
    await app(() => {}, { newChat: true });
    break;
  case 'new': {
    // no --agent: the form opens (agent, model, folder), preset from the other flags
    const agent = asAgent(flag('agent'));
    const folder = flag('folder') ? path.resolve(flag('folder')!.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')) : undefined;
    const skip = argv.includes('--skip-permissions');
    await app(c => {
      if (agent) c.newThread({ agent, title: positional[0], prompt: flag('task'), model: flag('model'), effort: flag('effort'), cwd: folder, skipPermissions: skip });
      else c.newChatScreen({ folder, model: flag('model'), effort: flag('effort'), skip });
    });
    break;
  }
  case 'run': {
    const agent = asAgent(positional[0]);
    if (!agent) {
      console.error('usage: chorus run <claude|codex|agy> [--thread id]');
      process.exit(2);
    }
    await app(c => {
      const id = flag('thread');
      const existing = id ? c.app.entry(id) : [...c.app.entries].reverse().find(e => e.agent === agent);
      if (existing) c.app.select(c.app.entries.indexOf(existing));
      else c.newThread({ agent });
    });
    break;
  }
  case 'handoff': {
    const to = asAgent(flag('to'));
    if (!to) {
      console.error('usage: chorus handoff --to <claude|codex|agy> [--from thread]');
      process.exit(2);
    }
    await app(async c => {
      const from = flag('from') ?? c.store.listThreads()[0]?.id;
      if (!from) {
        console.error('no thread to hand off yet');
        process.exit(1);
      }
      await c.handoff(from, to);
    });
    break;
  }
  case 'threads':
    console.log(threadsCmd(openStore()));
    break;
  case 'show':
    console.log(showCmd(openStore(), positional[0] ?? ''));
    break;
  case 'memory':
    console.log(memoryCmd(openStore(), positional[0] ?? ''));
    break;
  case 'artifacts': {
    const store = openStore();
    console.log(artifactsCmd(store, flag('thread')));
    if (argv.includes('--serve')) {
      // a local page per artifact that reloads while the agent edits it
      const srv = new PreviewServer(store);
      const base = await srv.start(Number(flag('port') ?? 4317));
      console.log(`\nserving ${base}  (ctrl+c to stop)`);
      for (const a of store.listArtifacts(flag('thread'))) console.log(`  ${srv.urlFor(a.thread_id, a.path)}`);
      if (argv.includes('--open')) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [base], { stdio: 'ignore', detached: true }).unref();
      await new Promise(() => {});
    }
    break;
  }
  case 'activity':
    console.log(activityCmd(openStore(), flag('thread')));
    break;
  case 'trace':
    console.log(traceCmd(openStore(), positional[0] ?? ''));
    break;
  case 'doctor':
    console.log(doctorCmd(project));
    break;
  case 'mcp':
    await runMcp(project, flag('thread'), flag('home'));
    break;
  case 'skills': {
    // the shared skill library: list, turn on or off for all three agents, import what the agents already have
    const sub = argv[1];
    const name = positional[1];
    const folderOf = (n?: string) => listSkills(project).map(s => path.basename(s.dir)).find(f => f === n);
    if (sub === 'sync') console.log(JSON.stringify(syncSkills(project), null, 2));
    else if (sub === 'list' || sub === undefined) {
      const off = disabledSkills(project);
      for (const s of listSkills(project)) console.log(`${off.includes(path.basename(s.dir)) ? '[off]' : '[on] '} ${s.name}\t${s.description}`);
      const found = findNativeSkills(project);
      if (found.length) console.log(`\nfound in the agents' own folders (chorus skills import <name>):\n${found.map(f => `  ${f.name}\t${f.from}`).join('\n')}`);
    } else if ((sub === 'on' || sub === 'off') && folderOf(name)) {
      setSkillEnabled(project, name, sub === 'on');
      console.log(JSON.stringify(syncSkills(project)));
    } else if (sub === 'import' && name) {
      const f = findNativeSkills(project).find(x => x.name === name || path.basename(x.dir) === name);
      if (!f) console.error(`no skill "${name}" found in the agents' folders`);
      else {
        importSkill(project, f);
        console.log(`imported ${f.name}: ${JSON.stringify(syncSkills(project))}`);
      }
    } else console.error('usage: chorus skills [list|on <name>|off <name>|import <name>|sync] [--project dir]');
    break;
  }
  case 'mux': {
    // dev command: run each shell command as a thread, e.g. chorus mux codex agy
    const ui = new App();
    argv.slice(1).forEach((c, i) => ui.addThread({ id: `t${i + 1}`, title: c, agent: c.split(' ')[0], file: process.env.SHELL || '/bin/sh', args: ['-c', c], cwd: process.cwd() }, i === 0));
    ui.start();
    await ui.done;
    process.exit(0);
    break;
  }
  default:
    console.error('usage: chorus [new|run|handoff|threads|show|memory|artifacts|activity|trace|doctor|skills|mcp|mux] …');
    process.exit(2);
}
