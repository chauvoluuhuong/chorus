// Screen detection for bare `chorus` (plan 2026-11-07 part A.4, A.8).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserOpener, inContainer, noScreen, noScreenMessage, type ScreenEnv } from '../../src/cli/screen.ts';

const at = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, files: string[] = []): ScreenEnv => ({ platform, env, exists: p => files.includes(p) });

test('screen: a Mac has one, unless reached over SSH', () => {
  assert.equal(noScreen(at('darwin')), undefined);
  assert.equal(noScreen(at('darwin', { SSH_CONNECTION: '1 2 3 4' })), 'ssh');
  assert.equal(noScreen(at('darwin', { SSH_TTY: '/dev/ttys001' })), 'ssh');
  assert.equal(browserOpener(at('darwin')), 'open');
});

test('screen: Linux needs X11 or Wayland', () => {
  assert.equal(noScreen(at('linux', { DISPLAY: ':0' })), undefined);
  assert.equal(noScreen(at('linux', { WAYLAND_DISPLAY: 'wayland-0' })), undefined);
  assert.equal(noScreen(at('linux', {})), 'no-display');
  assert.equal(noScreen(at('linux', { SSH_CONNECTION: 'x' })), 'ssh');
  assert.equal(noScreen(at('linux', { SSH_CONNECTION: 'x', DISPLAY: 'localhost:10.0' })), undefined, 'X forwarded over SSH');
});

test('screen: a container has none, even with DISPLAY set', () => {
  assert.equal(inContainer(at('linux', {}, ['/.dockerenv'])), true);
  assert.equal(noScreen(at('linux', { DISPLAY: ':0' }, ['/.dockerenv'])), 'container');
  assert.equal(noScreen(at('linux', { DISPLAY: ':0' }, ['/run/.containerenv'])), 'container', 'Podman');
});

test('screen: --open is skipped when nothing can open a browser', () => {
  assert.equal(browserOpener(at('linux', { DISPLAY: ':0', PATH: '/usr/bin' }, ['/usr/bin/xdg-open'])), 'xdg-open');
  assert.equal(browserOpener(at('linux', { DISPLAY: ':0', PATH: '/usr/bin' })), undefined, 'no xdg-open');
  assert.equal(browserOpener(at('linux', { PATH: '/usr/bin' }, ['/usr/bin/xdg-open'])), undefined, 'no screen');
});

test('screen: the no-screen message gives the address, --host and chorus-cli', () => {
  const m = noScreenMessage('http://127.0.0.1:4318/?token=abc', 'ssh');
  assert.match(m, /There's no screen here, so open this in a browser:\n  http:\/\/127\.0\.0\.1:4318\/\?token=abc/);
  assert.match(m, /--host/);
  assert.match(m, /chorus-cli/);
  assert.doesNotMatch(noScreenMessage('u', 'container', '0.0.0.0'), /--host/, 'already started with --host');
});
