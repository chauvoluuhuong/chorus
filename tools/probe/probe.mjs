#!/usr/bin/env node
// Chorus capability probe.
//
// Runs one AI CLI (claude | codex | agy) through a fixed set of scenarios in a
// throwaway workspace and records everything it emits, so integration code is
// written against real captured output instead of assumptions.
//
//   node tools/probe/probe.mjs <claude|codex|agy> [options]
//
// Options:
//   --scenario <name>   hello | mcp | shell | artifact | resume | all (default: all)
//   --model <id>        model to pass to the CLI (default: the CLI's own default)
//   --bin <path>        CLI binary (default: claude / codex / agy on PATH)
//   --out <dir>         fixture root (default: fixtures)
//   --timeout <sec>     per-run timeout (default: 300)
//
// Output: <out>/<cli>/<version>/<scenario>/ with command.json, stdout.jsonl,
// stderr.txt, mcp-log.jsonl, home-changes.json (+ copied text files),
// workspace-files.json and result.json. A summary is printed at the end.
//
// The prompts are harmless and run in an empty temp workspace. Emails, account
// ids and the home path are redacted, but still review fixtures before committing.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(HERE, 'probe-mcp.mjs');

/* ---------------- args ---------------- */

const argv = process.argv.slice(2);
const cli = argv[0];
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
if (!['claude', 'codex', 'agy'].includes(cli)) {
  console.error('usage: node tools/probe/probe.mjs <claude|codex|agy> [--scenario all] [--model id] [--bin path]');
  process.exit(2);
}
const bin = opt('bin', cli);
const model = opt('model');
const outRoot = path.resolve(opt('out', 'fixtures'));
const timeoutMs = Number(opt('timeout', 300)) * 1000;
const scenarioArg = opt('scenario', 'all');

/* ---------------- environment ---------------- */

// Variables a parent Claude Code session leaks into child processes. If they
// are inherited, a child `claude` reuses the parent's session id (verified).
const SCRUB_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID'];
const childEnv = { ...process.env };
for (const k of SCRUB_ENV) delete childEnv[k];

/* ---------------- redaction ---------------- */

// Fixtures get committed, so strip account identifiers from everything we write.
// Extra literal values can be added with --redact a,b,c.
const REDACT_VALUES = [
  process.env.CLAUDE_CODE_ORGANIZATION_UUID,
  process.env.CLAUDE_CODE_ACCOUNT_UUID,
  ...(opt('redact', '') || '').split(','),
].filter(v => v && v.length >= 6);
const REDACT_KEYS =
  /("(?:organizationUuid|organization_uuid|accountUuid|account_uuid|userId|user_id|email|userEmail|account_id|accountId|creator_user_id|creator_account_id)"\s*:\s*)"[^"]*"/g;

function redact(text) {
  let t = text.replace(REDACT_KEYS, '$1"<redacted>"');
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  for (const v of REDACT_VALUES) t = t.split(v).join('<redacted>');
  return t.split(os.homedir()).join('~');
}
const writeRedacted = (file, text) => fs.writeFileSync(file, redact(text));

/* ---------------- per-CLI adapters ---------------- */

const HOME = os.homedir();
const tomlString = s => JSON.stringify(s); // JSON strings are valid TOML basic strings

const ADAPTERS = {
  claude: {
    homeDirs: [path.join(HOME, '.claude', 'projects')],
    setup() {},
    args({ prompt, ws, mcpArgs, sessionId, resumeId }) {
      const mcpConfig = JSON.stringify({ mcpServers: { chorus: { command: 'node', args: mcpArgs } } });
      return [
        '-p', prompt,
        ...(resumeId ? ['--resume', resumeId] : ['--session-id', sessionId]),
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'acceptEdits',
        ...(model ? ['--model', model] : []),
        '--strict-mcp-config',
        '--mcp-config', mcpConfig,
        '--allowedTools', 'mcp__chorus__probe_get_context,Bash(echo *),Write,Edit',
      ];
    },
  },
  codex: {
    homeDirs: [process.env.CODEX_HOME || path.join(HOME, '.codex')],
    setup() {},
    args({ prompt, mcpArgs, resumeId }) {
      const cfg = [
        '-c', `mcp_servers.chorus.command=${tomlString('node')}`,
        '-c', `mcp_servers.chorus.args=[${mcpArgs.map(tomlString).join(',')}]`,
        '-c', 'mcp_servers.chorus.default_tools_approval_mode="approve"',
        '-c', 'approval_policy="never"',
      ];
      const common = ['--json', '--skip-git-repo-check', '-s', 'workspace-write', ...(model ? ['-m', model] : []), ...cfg];
      return resumeId ? ['exec', ...common, 'resume', resumeId, prompt] : ['exec', ...common, prompt];
    },
  },
  agy: {
    // ~/.gemini/antigravity-cli is the CLI store per community docs; ~/.gemini/config
    // holds global mcp_config.json/rules. Both are watched so the probe shows which is real.
    homeDirs: [path.join(HOME, '.gemini')],
    setup({ ws, mcpArgs }) {
      // agy has no known per-session MCP flag. Try the workspace-level config
      // (.agents/mcp_config.json) so the user's global config is never touched.
      // Whether agy reads it is one of the things this probe verifies.
      fs.mkdirSync(path.join(ws, '.agents'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.agents', 'mcp_config.json'),
        JSON.stringify({ mcpServers: { chorus: { command: 'node', args: mcpArgs } } }, null, 2),
      );
    },
    args({ prompt, resumeId }) {
      return [
        ...(resumeId ? ['--conversation', resumeId] : []),
        '-p', prompt,
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        ...(model ? ['--model', model] : []),
      ];
    },
  },
};
const adapter = ADAPTERS[cli];

/* ---------------- scenarios ---------------- */

// Each scenario is one or two runs plus checks against the captured output.
// Expected tokens never appear in the prompt, so an echoed prompt cannot pass a check.
const SCENARIOS = {
  hello: {
    runs: [{ prompt: 'Reply with exactly the two words: got it' }],
    checks: ({ runs }) => [
      check('exit code 0', runs[0].exitCode === 0, runs[0].exitCode),
      check('session id found in stream', !!runs[0].sessionId, runs[0].sessionId),
      check('token usage present in stream', /"(usage|input_tokens|total_tokens)"/.test(runs[0].stdout)),
    ],
  },
  mcp: {
    runs: [
      {
        prompt:
          'Call the tool named probe_get_context from the MCP server named "chorus". ' +
          'Then reply with only the value of secret_word from its result.',
      },
    ],
    checks: ({ runs, mcpLog, threadId }) => [
      check('MCP server was started', mcpLog.some(e => e.dir === 'start')),
      check('MCP initialize received', mcpLog.some(e => e.msg?.method === 'initialize')),
      check('tools/call received', mcpLog.some(e => e.msg?.method === 'tools/call')),
      check('thread id passed via argv', mcpLog.some(e => e.dir === 'start' && e.argv?.includes(threadId))),
      check('model saw tool result', runs[0].stdout.includes('pineapple')),
    ],
  },
  shell: {
    runs: [
      {
        prompt:
          'Use your shell / terminal tool to run exactly this command: echo chorus-probe-$((6*7)) ' +
          'Then reply with the command output only.',
      },
    ],
    checks: ({ runs }) => [
      check('exit code 0', runs[0].exitCode === 0, runs[0].exitCode),
      check('command output visible in stream', runs[0].stdout.includes('chorus-probe-42')),
    ],
  },
  artifact: {
    runs: [
      {
        prompt:
          'Create the file .chorus/artifacts/probe/hello.md (create folders as needed) containing a ' +
          'level-1 heading "Probe artifact" and one short sentence. Then reply with the word: done',
      },
    ],
    checks: ({ ws }) => {
      const f = path.join(ws, '.chorus', 'artifacts', 'probe', 'hello.md');
      return [check('artifact file written at requested path', fs.existsSync(f))];
    },
  },
  resume: {
    runs: [
      { prompt: 'Remember this code word for later: mango. Reply with only: ok' },
      { resume: true, prompt: 'What was the code word I gave you earlier? Reply with one word only.' },
    ],
    checks: ({ runs }) => [
      check('first run produced a session id', !!runs[0].sessionId, runs[0].sessionId),
      check('second run exit code 0', runs[1]?.exitCode === 0, runs[1]?.exitCode),
      check('resumed run kept the same session id', runs[1]?.sessionId === runs[0].sessionId, runs[1]?.sessionId),
      check('resumed run remembered context', /mango/i.test(runs[1]?.stdout ?? '')),
    ],
  },
};

function check(name, ok, detail) {
  return { name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) };
}

/* ---------------- helpers ---------------- */

function cliVersion() {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env: childEnv });
  if (r.error) throw new Error(`cannot run "${bin}": ${r.error.message}`);
  return (r.stdout || r.stderr).trim().split('\n')[0];
}

// Walk a directory and return { relPath: "mtimeMs:size" }. Bounded so a huge
// home dir cannot hang the probe.
function snapshot(root, limit = 200_000) {
  const out = {};
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  let n = 0;
  while (stack.length && n < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') stack.push(p);
      } else if (e.isFile()) {
        try {
          const s = fs.statSync(p);
          out[path.relative(root, p)] = `${s.mtimeMs}:${s.size}`;
          n++;
        } catch {}
      }
    }
  }
  return out;
}

const TEXT_EXT = new Set(['.jsonl', '.json', '.md', '.txt', '.log', '.toml', '.yaml', '.yml', '']);
const MAX_COPY = 5 * 1024 * 1024;
// Only session transcripts are worth keeping. Config, caches, bundled skills and
// plugin files are user-specific or noise, so they are listed but never copied.
const COPY_PATTERN = /^-[^/]*\/[^/]+\.jsonl$|(^|\/)(projects|sessions)\/.*\.jsonl$|(^|\/)brain\/[^/]+\/\.system_generated\/logs\/transcript\.jsonl$/;

// Record which files the CLI created/changed in its home dir, and copy the
// small text ones (transcripts, session indexes) into the fixture.
function captureHomeChanges(before, dest, ws) {
  // Claude keeps every project's sessions in one folder: only report this workspace's own,
  // so other projects' names never end up in fixtures.
  const slugs = [ws, fs.realpathSync(ws)].map(w => w.replace(/[^a-zA-Z0-9]/g, '-'));
  const mine = rel => cli !== 'claude' || slugs.some(s => rel.startsWith(s));
  const changes = [];
  for (const root of adapter.homeDirs) {
    const after = snapshot(root);
    for (const [rel, sig] of Object.entries(after)) {
      if (before[root][rel] === sig || !mine(rel)) continue;
      const abs = path.join(root, rel);
      const size = Number(sig.split(':')[1]);
      const copied = COPY_PATTERN.test(rel) && TEXT_EXT.has(path.extname(rel)) && size <= MAX_COPY;
      if (copied) {
        const to = path.join(dest, 'home-changes', path.basename(root), rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        writeRedacted(to, fs.readFileSync(abs, 'utf8'));
      }
      changes.push({ path: abs.replace(HOME, '~'), status: before[root][rel] ? 'modified' : 'created', size, copied });
    }
  }
  return changes;
}

function listFiles(dir) {
  return Object.keys(snapshot(dir)).filter(p => !p.startsWith('.git' + path.sep));
}

function parseLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      events.push(JSON.parse(t));
    } catch {}
  }
  return events;
}

// First session/thread/conversation id found anywhere in the event stream.
function findSessionId(events) {
  const KEYS = ['session_id', 'thread_id', 'conversation_id', 'sessionId', 'conversationId'];
  const visit = v => {
    if (!v || typeof v !== 'object') return undefined;
    for (const k of KEYS) if (typeof v[k] === 'string' && v[k]) return v[k];
    for (const child of Object.values(v)) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const e of events) {
    const hit = visit(e);
    if (hit) return hit;
  }
  return undefined;
}

function run(args, cwd) {
  return new Promise(resolve => {
    const started = Date.now();
    // stdin is closed: agy -p blocks reading an open stdin.
    const child = spawn(bin, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, durationMs: Date.now() - started, stdout, stderr });
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ exitCode: null, error: err.message, durationMs: Date.now() - started, stdout, stderr });
    });
  });
}

/* ---------------- main ---------------- */

const version = cliVersion();
const versionSlug = (version.match(/\d+\.\d+\.\d+[\w.-]*/) ?? [version.replace(/[^\w.-]+/g, '_')])[0].slice(0, 60);
const names = scenarioArg === 'all' ? Object.keys(SCENARIOS) : scenarioArg.split(',');
console.log(`probing ${cli} (${version}) → ${path.join(outRoot, cli, versionSlug)}`);

const summary = [];
for (const name of names) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`unknown scenario: ${name}`);
    process.exit(2);
  }
  const dest = path.join(outRoot, cli, versionSlug, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `chorus-probe-${cli}-${name}-`));
  spawnSync('git', ['init', '-q'], { cwd: ws });
  const threadId = `t_probe_${name}`;
  const mcpLogFile = path.join(dest, 'mcp-log.jsonl');
  const mcpArgs = [MCP_SERVER, '--log', mcpLogFile, '--thread', threadId];
  adapter.setup({ ws, mcpArgs });

  const before = Object.fromEntries(adapter.homeDirs.map(r => [r, snapshot(r)]));
  const runs = [];
  const commands = [];
  for (const [i, spec] of scenario.runs.entries()) {
    const resumeId = spec.resume ? runs[0]?.sessionId : undefined;
    if (spec.resume && !resumeId) {
      runs.push({ skipped: 'no session id from first run', stdout: '' });
      continue;
    }
    const sessionId = randomUUID();
    const args = adapter.args({ prompt: spec.prompt, ws, mcpArgs, sessionId, resumeId });
    commands.push({ bin, args, cwd: ws });
    process.stdout.write(`  ${name}#${i + 1} … `);
    const r = await run(args, ws);
    r.events = parseLines(r.stdout);
    r.sessionId = findSessionId(r.events);
    runs.push(r);
    const suffix = scenario.runs.length > 1 ? `.${i + 1}` : '';
    writeRedacted(path.join(dest, `stdout${suffix}.jsonl`), r.stdout);
    writeRedacted(path.join(dest, `stderr${suffix}.txt`), r.stderr);
    console.log(`exit=${r.exitCode}${r.timedOut ? ' (timeout)' : ''} ${r.durationMs}ms`);
  }

  const homeChanges = captureHomeChanges(before, dest, ws);
  const mcpLog = fs.existsSync(mcpLogFile) ? parseLines(fs.readFileSync(mcpLogFile, 'utf8')) : [];
  const checks = scenario.checks({ runs, mcpLog, threadId, ws });
  if (fs.existsSync(mcpLogFile)) writeRedacted(mcpLogFile, fs.readFileSync(mcpLogFile, 'utf8'));
  const result = {
    cli,
    version,
    scenario: name,
    date: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    scrubbedEnv: SCRUB_ENV,
    passed: checks.every(c => c.ok),
    checks,
    runs: runs.map(r => ({
      exitCode: r.exitCode,
      signal: r.signal,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      sessionId: r.sessionId,
      eventTypes: [...new Set((r.events ?? []).map(e => e.type ?? e.event ?? '?'))],
      skipped: r.skipped,
      error: r.error,
    })),
  };
  fs.writeFileSync(path.join(dest, 'command.json'), redact(JSON.stringify(commands, null, 2)));
  fs.writeFileSync(path.join(dest, 'home-changes.json'), JSON.stringify(homeChanges, null, 2));
  fs.writeFileSync(path.join(dest, 'workspace-files.json'), JSON.stringify(listFiles(ws), null, 2));
  fs.writeFileSync(path.join(dest, 'result.json'), JSON.stringify(result, null, 2));
  fs.rmSync(ws, { recursive: true, force: true });
  summary.push({ name, checks });
}

console.log('\nresults:');
for (const s of summary) {
  for (const c of s.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${s.name}: ${c.name}${c.ok || c.detail === undefined ? '' : ` (${c.detail})`}`);
}
const failed = summary.some(s => s.checks.some(c => !c.ok));
process.exit(failed ? 1 : 0);
