#!/usr/bin/env node
// Checks that the single-executable build really works: the app hosts a PTY thread, and `chorus mcp` serves tools.
//   node tools/packaging/verify-sea.mjs [dist/sea/chorus]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const bin = path.resolve(process.argv[2] ?? 'dist/sea/chorus');
const ROOT = path.resolve(import.meta.dirname, '../..');
let failed = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + d}`); if (!ok) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. the app in a PTY, hosting the fake TUI as a thread
const term = new Terminal({ cols: 100, rows: 24, allowProposedApi: true });
const p = pty.spawn(bin, ['mux', `${process.execPath} ${path.join(ROOT, 'tools/fake-agent/fake-tui.mjs')} sea`], { name: 'xterm-256color', cols: 100, rows: 24, cwd: os.tmpdir(), env: { ...process.env, TERM: 'xterm-256color' } });
p.onData(d => term.write(d));
await sleep(3500);
const screen = () => { const b = term.buffer.active; const l = []; for (let y = 0; y < 24; y++) l.push(b.getLine(y).translateToString(true)); return l; };
check('app starts and shows the sidebar and the hosted thread (node-pty loaded next to the binary)', /CHORUS/.test(screen()[0]) && screen().some(l => /READY sea/.test(l)), screen().join('|').slice(0, 300));
p.write('hello\r');
await sleep(800);
check('keys reach the thread', screen().some(l => /got: "hello"/.test(l)));
p.write('\x00q'); await sleep(300); p.write('\x00q'); await sleep(800);

// 2. the MCP server, started from the same binary
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-sea-'));
const c = new Client({ name: 'verify', version: '0' });
await c.connect(new StdioClientTransport({ command: bin, args: ['mcp', '--project', proj, '--thread', 't_sea'] }));
const tools = (await c.listTools()).tools.map(t => t.name).sort();
check('chorus mcp serves the six tools', tools.length === 6 && tools.includes('get_handoff_context'), tools.join(','));
await c.close();
console.log(failed ? '\nFAILED' : '\nOK');
process.exit(failed ? 1 : 0);
