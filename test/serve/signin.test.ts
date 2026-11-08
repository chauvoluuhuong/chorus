// Signing in the CLIs from the page in a container (src/serve/signin.ts). The outputs are what each CLI printed in the Chorus box on
// 2026-11-08 (claude 2.1.310, codex 0.164.0, agy 1.4.5), with the secrets in the links and the code replaced.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainText, readSignIn, SignIns } from '../../src/serve/signin.ts';
import type { PtyFactory } from '../../src/app/pty.ts';

const CLAUDE = 'Opening browser to sign in…\r\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=X&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=S\r\nPaste code here if prompted > ';
const CODEX = '\r\nWelcome to Codex [v\x1b[90m0.164.0\x1b[0m]\r\n\r\nFollow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n1. Open this link in your browser and sign in to your account\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   \x1b[94mAB12-CD34E\x1b[0m\r\n';
const AGY_MENU = '\x1b[?2026h Welcome to the Antigravity CLI. You are currently not signed in.\r\n Select login method:\r\n \x1b[1m> 1. Google OAuth\x1b[0m\r\n   2. Use a Google Cloud project\r\n';
const AGY_LINK = ' \x1b[32m⣾\x1b[0m  Signing in...Your browser should open automatically. If not:\r\n \x1b]8;id=jk1;https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=X&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=S\x1b\\https://accounts.google.com/o/oauth2/auth?access_ty\x1b]8;;\x1b\\\r\n';

test('signin: the link and code in what each CLI prints', () => {
  assert.equal(readSignIn('claude', CLAUDE).url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=X&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=S');
  assert.equal(readSignIn('claude', CLAUDE).codeBack, 'required');
  assert.deepEqual(readSignIn('codex', CODEX), { url: 'https://auth.openai.com/codex/device', userCode: 'AB12-CD34E' });
  assert.equal(readSignIn('agy', AGY_MENU + AGY_LINK).url, 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=X&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=S', 'the whole link from the hyperlink, not the cut visible text');
  assert.equal(readSignIn('agy', AGY_MENU).url, undefined);
  assert.doesNotMatch(plainText(CODEX), /\x1b/);
});

/** A PTY the test drives: what the CLI prints, what Chorus types. */
function fakePty() {
  const typed: string[] = [];
  let out: (d: string) => void = () => {};
  let exit: (c: number | null) => void = () => {};
  const spawned: string[][] = [];
  const factory: PtyFactory = (file, args) => {
    spawned.push([file, ...args]);
    return { pid: 1, onData: cb => void (out = cb), onExit: cb => void (exit = cb), write: d => void typed.push(d), resize() {}, kill() { exit(null); } };
  };
  return { factory, typed, spawned, print: (d: string) => out(d), exit: (c: number) => exit(c) };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('signin: Claude: link, then the code from the page typed back, then done', async () => {
  const p = fakePty();
  const runs = new SignIns({ pty: p.factory, env: { PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x' } });
  const s = runs.start('claude');
  assert.deepEqual(p.spawned[0], ['claude', 'auth', 'login']);
  assert.equal(s.state, 'starting');
  p.print(CLAUDE);
  assert.equal(s.state, 'waiting');
  assert.match(s.url!, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.deepEqual(runs.sendCode(s.id, 'abc\ndef'), { error: 'Paste the code the sign-in page shows' }, 'no line breaks typed into the CLI');
  assert.deepEqual(runs.sendCode(s.id, '  abc#def  '), { ok: true });
  assert.deepEqual(p.typed, ['abc#def\r']);
  p.print('\r\nLogin successful.\r\n');
  p.exit(0);
  assert.equal(runs.get(s.id)!.state, 'done');
  runs.close();
});

test('signin: Codex waits for its one-time code, finishes by itself; a failure says why', () => {
  const p = fakePty();
  const runs = new SignIns({ pty: p.factory, env: {} });
  const s = runs.start('codex');
  assert.deepEqual(p.spawned[0], ['codex', 'login', '--device-auth']);
  p.print(CODEX.slice(0, CODEX.indexOf('2. Enter')));
  assert.equal(s.state, 'starting', 'the link alone is not enough: the code comes next');
  p.print(CODEX.slice(CODEX.indexOf('2. Enter')));
  assert.equal(s.state, 'waiting');
  assert.equal(s.userCode, 'AB12-CD34E');
  p.exit(0);
  assert.equal(s.state, 'done');
  const q = fakePty();
  const runs2 = new SignIns({ pty: q.factory, env: {} });
  const f = runs2.start('codex');
  q.print('Error: device code expired\r\n');
  q.exit(1);
  assert.equal(f.state, 'failed');
  assert.match(f.error!, /device code expired/);
  runs.close();
  runs2.close();
});

test('signin: agy: Google OAuth is picked in its menu, the link comes from the hyperlink; a new sign-in replaces the old', async () => {
  const p = fakePty();
  const runs = new SignIns({ pty: p.factory, env: {} });
  const s = runs.start('agy');
  assert.deepEqual(p.spawned[0], ['agy']);
  p.print(AGY_MENU);
  await sleep(400);
  assert.deepEqual(p.typed, ['\r'], 'Enter picks "1. Google OAuth"');
  p.print(AGY_LINK);
  assert.equal(s.state, 'waiting');
  assert.equal(s.codeBack, 'maybe');
  const again = runs.start('agy');
  assert.equal(runs.get(s.id), undefined, 'the old one is closed');
  assert.notEqual(again.id, s.id);
  runs.cancel(again.id, true);
  assert.equal(again.state, 'done', 'the user said it is done');
  runs.close();
});
