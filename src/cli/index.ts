#!/usr/bin/env node
// chorus: entry point. Phase 3 commands: mcp, skills. The app (Phase 4) builds on the same core.
import path from 'node:path';
import { syncSkills, listSkills } from '../core/skills.ts';
import { App } from '../app/app.ts';
import { runMcp } from '../mcp/server.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const project = path.resolve(flag('project') ?? process.cwd());

switch (argv[0]) {
  case 'mcp':
    await runMcp(project, flag('thread'));
    break;
  case 'skills': {
    if (argv[1] === 'sync') console.log(JSON.stringify(syncSkills(project), null, 2));
    else if (argv[1] === 'list') for (const s of listSkills(project)) console.log(`${s.name}\t${s.description}`);
    else console.error('usage: chorus skills <sync|list> [--project dir]');
    break;
  }
  case 'mux': {
    // dev command: run each shell command as a thread, e.g. chorus mux codex agy
    const app = new App();
    argv.slice(1).forEach((cmd, i) => app.addThread({ id: `t${i + 1}`, title: cmd, agent: cmd.split(' ')[0], file: process.env.SHELL || '/bin/sh', args: ['-c', cmd], cwd: process.cwd() }, i === 0));
    app.start();
    await app.done;
    process.exit(0);
    break;
  }
  default:
    console.error('usage: chorus <mcp|skills|mux> …');
    process.exit(argv[0] ? 2 : 0);
}
