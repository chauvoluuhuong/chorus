#!/usr/bin/env node
// chorus: the CLI app (Phase 4) and its plain commands. `chorus mcp` is started by the agents, not by you.
import path from 'node:path';
import { App } from '../app/app.ts';
import { AGENTS, Controller } from '../app/controller.ts';
import { Store } from '../core/store.ts';
import type { AgentId } from '../core/types.ts';
import { syncSkills, listSkills } from '../core/skills.ts';
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

async function app(start: (c: Controller) => Promise<void> | void) {
  const store = new Store(project);
  const ui = new App();
  const c = new Controller({ project, store, app: ui, models: models() });
  c.restore();
  await start(c);
  ui.start();
  if (!ui.entries.length) ui.emit('action', 'new');
  await ui.done;
  store.close();
  process.exit(0);
}

const cmd = argv[0];
switch (cmd) {
  case undefined:
  case 'app':
    await app(() => {});
    break;
  case 'new': {
    const agent = asAgent(flag('agent')) ?? 'claude';
    await app(c => void c.newThread({ agent, title: positional[0], prompt: flag('task') }));
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
    console.log(threadsCmd(new Store(project)));
    break;
  case 'show':
    console.log(showCmd(new Store(project), positional[0] ?? ''));
    break;
  case 'memory':
    console.log(memoryCmd(new Store(project), positional[0] ?? ''));
    break;
  case 'artifacts':
    console.log(artifactsCmd(new Store(project), flag('thread')));
    break;
  case 'activity':
    console.log(activityCmd(new Store(project), flag('thread')));
    break;
  case 'trace':
    console.log(traceCmd(new Store(project), positional[0] ?? ''));
    break;
  case 'doctor':
    console.log(doctorCmd(project));
    break;
  case 'mcp':
    await runMcp(project, flag('thread'));
    break;
  case 'skills':
    if (argv[1] === 'sync') console.log(JSON.stringify(syncSkills(project), null, 2));
    else if (argv[1] === 'list') for (const s of listSkills(project)) console.log(`${s.name}\t${s.description}`);
    else console.error('usage: chorus skills <sync|list> [--project dir]');
    break;
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
