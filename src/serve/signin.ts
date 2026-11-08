// Signing in an AI CLI from the page when Chorus runs in a container (the Chorus box): there is no terminal to open, and the user's
// browser is on another machine (the host). Chorus runs the CLI's own sign-in in a PTY, reads the sign-in link (and the one-time code)
// it prints, and hands them to the page, which opens the link in a new tab and shows a popup: the link again, the code to enter, or a
// box for the code the sign-in page gives back. Seen in the box on 2026-11-08 (chorus-core docs/integrations, "inside a container"):
//   claude 2.1.310   `claude auth login`: a link (…/cai/oauth/authorize…), then "Paste code here if prompted >"
//   codex  0.164.0   `codex login --device-auth`: https://auth.openai.com/codex/device and a one-time code; finishes by itself
//   agy    1.4.5     `agy`: a menu ("1. Google OAuth" first, Enter picks it), then a Google link (an OSC 8 hyperlink) whose callback is
//                    https://antigravity.google/oauth-callback; what that page asks next was not seen yet, so a code box is offered
import crypto from 'node:crypto';
import os from 'node:os';
import type { AgentId } from '../core/types.ts';
import { nodePtyFactory, type PtyFactory, type PtyLike } from '../app/pty.ts';

export interface SignIn {
  id: string;
  agent: AgentId;
  /** starting: no link yet · waiting: the link is out, waiting for the user · done: the CLI finished · failed */
  state: 'starting' | 'waiting' | 'done' | 'failed';
  /** the sign-in page to open */
  url?: string;
  /** Codex: the one-time code to enter on that page */
  userCode?: string;
  /** the page gives a code to paste back here: required (Claude), maybe (agy) */
  codeBack?: 'required' | 'maybe';
  /** the code was sent to the CLI */
  codeSent?: boolean;
  /** the end of what the CLI printed, without colours (shown when it fails) */
  output: string;
  error?: string;
}

const COMMANDS: Record<AgentId, string[]> = {
  claude: ['claude', 'auth', 'login'],
  codex: ['codex', 'login', '--device-auth'],
  agy: ['agy'],
};

/** What the CLI printed, as plain text: no colours, cursor moves or hyperlink wrappers (their link is kept once). */
export function plainText(s: string) {
  return s
    .replace(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, (_, url) => (url ? ` ${url} ` : ''))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[78=>]/g, '')
    .replace(/\r/g, '');
}

/** The sign-in link and code in what an agent's sign-in printed so far. */
export function readSignIn(agent: AgentId, raw: string): Pick<SignIn, 'url' | 'userCode' | 'codeBack'> {
  const text = plainText(raw);
  if (agent === 'claude') {
    const url = text.match(/https:\/\/\S*oauth\/authorize\S+/)?.[0];
    return { url, codeBack: 'required' };
  }
  if (agent === 'codex') {
    const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device\S*/)?.[0];
    const userCode = text.match(/one-time code[\s\S]*?\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1];
    return { url, userCode };
  }
  // agy draws the link as a hyperlink (OSC 8), the whole address in one piece; the visible text wraps
  const link = raw.match(/\x1b\]8;[^;\x07\x1b]*;(https:\/\/accounts\.google\.com\/[^\x07\x1b]+)/)?.[1] ?? text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/\S+/)?.[0];
  return { url: link, codeBack: 'maybe' };
}

export interface SignInOpts {
  pty?: PtyFactory;
  env?: NodeJS.ProcessEnv;
  /** gives up after this long (the codes expire after 15 minutes) */
  timeoutMs?: number;
  /** called on every change, so the page can be told */
  onChange?: (s: SignIn) => void;
}

/** One sign-in at a time per agent; a new one replaces the old. */
export class SignIns {
  private runs = new Map<string, { s: SignIn; p: PtyLike; raw: string; timer: NodeJS.Timeout }>();
  private o: SignInOpts;
  constructor(o: SignInOpts = {}) {
    this.o = o;
  }

  start(agent: AgentId): SignIn {
    for (const [id, r] of this.runs) if (r.s.agent === agent) this.cancel(id);
    const [bin, ...args] = COMMANDS[agent];
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.o.env ?? process.env)) if (v !== undefined && !/^CLAUDE_?CODE|^CLAUDE_PID$/.test(k)) env[k] = v;
    // wide, so a link is never cut by a line wrap
    const p = (this.o.pty ?? nodePtyFactory)(bin, args, { cols: 1000, rows: 50, cwd: os.homedir(), env });
    const s: SignIn = { id: crypto.randomBytes(6).toString('hex'), agent, state: 'starting', output: '' };
    const run = { s, p, raw: '', timer: setTimeout(() => this.fail(s.id, 'The sign-in took too long. Try again.'), this.o.timeoutMs ?? 15 * 60_000).unref() };
    this.runs.set(s.id, run);
    let picked = false;
    p.onData(d => {
      run.raw = (run.raw + d).slice(-200_000);
      s.output = plainText(run.raw).split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-12).join('\n');
      // agy asks how to sign in first: Google OAuth is the first choice
      if (agent === 'agy' && !picked && /Select login method/.test(plainText(run.raw))) {
        picked = true;
        setTimeout(() => p.write('\r'), 300);
      }
      if (s.state === 'starting') {
        const found = readSignIn(agent, run.raw);
        if (found.url && (agent !== 'codex' || found.userCode)) Object.assign(s, found, { state: 'waiting' });
      }
      this.o.onChange?.(s);
    });
    p.onExit(code => {
      clearTimeout(run.timer);
      // the page reads how it ended for a while, then it is forgotten
      setTimeout(() => this.runs.get(s.id)?.s === s && this.runs.delete(s.id), 5 * 60_000).unref();
      if (s.state === 'done' || s.state === 'failed') return;
      if (code === 0) s.state = 'done';
      else Object.assign(s, { state: 'failed', error: s.output.split('\n').at(-1) || `the sign-in stopped (exit ${code})` });
      this.o.onChange?.(s);
    });
    return s;
  }

  get(id: string) {
    return this.runs.get(id)?.s;
  }

  /** The code the sign-in page gave, typed back into the CLI. */
  sendCode(id: string, code: string) {
    const r = this.runs.get(id);
    if (!r || r.s.state !== 'waiting') return { error: 'This sign-in is not waiting for a code' };
    const clean = code.trim();
    if (!clean || /[\r\n\x1b]/.test(clean)) return { error: 'Paste the code the sign-in page shows' };
    r.p.write(clean + '\r');
    r.s.codeSent = true;
    this.o.onChange?.(r.s);
    return { ok: true };
  }

  /** The user closed the popup, or marked it done (agy keeps running after it signs in). */
  cancel(id: string, done = false) {
    const r = this.runs.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    if (r.s.state === 'starting' || r.s.state === 'waiting') r.s.state = done ? 'done' : 'failed';
    r.p.kill();
    this.runs.delete(id);
  }

  close() {
    for (const id of [...this.runs.keys()]) this.cancel(id);
  }

  private fail(id: string, error: string) {
    const r = this.runs.get(id);
    if (!r) return;
    Object.assign(r.s, { state: 'failed', error });
    this.o.onChange?.(r.s);
    this.cancel(id);
  }
}
