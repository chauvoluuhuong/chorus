// Is there a screen to open the Chorus window (or a browser) on? private plan 2026-11-07-browser-everywhere-and-docker (part A).
import fs from 'node:fs';
import path from 'node:path';

export interface ScreenEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** fs.existsSync, replaced in tests */
  exists: (p: string) => boolean;
}

const real = (): ScreenEnv => ({ platform: process.platform, env: process.env, exists: fs.existsSync });

/** Inside a Docker or Podman container. */
export function inContainer(s: ScreenEnv = real()) {
  return s.exists('/.dockerenv') || s.exists('/run/.containerenv');
}

/**
 * Why there is no screen here, or undefined when there is one. No screen: a container; Linux with no X11 or Wayland session
 * (`DISPLAY`, `WAYLAND_DISPLAY`); an SSH session with no display forwarded (on a Mac too: the window would open on the Mac's own
 * screen, not the one the user is looking at).
 */
export function noScreen(s: ScreenEnv = real()): 'container' | 'ssh' | 'no-display' | undefined {
  if (s.platform === 'linux' && inContainer(s)) return 'container';
  const display = !!(s.env.DISPLAY || s.env.WAYLAND_DISPLAY);
  if ((s.env.SSH_CONNECTION || s.env.SSH_TTY || s.env.SSH_CLIENT) && !display) return 'ssh';
  if (s.platform === 'linux' && !display) return 'no-display';
  return undefined;
}

/** The program that opens a link in the browser here, or undefined when there is none (no screen, or no xdg-open on Linux). */
export function browserOpener(s: ScreenEnv = real()): string | undefined {
  if (noScreen(s)) return undefined;
  if (s.platform === 'darwin') return 'open';
  if (s.platform === 'win32') return 'explorer';
  const dirs = (s.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some(d => s.exists(path.join(d, 'xdg-open'))) ? 'xdg-open' : undefined;
}

/** What bare `chorus` prints when it serves for a browser because there is no screen. */
export function noScreenMessage(openUrl: string, why: ReturnType<typeof noScreen>, host?: string) {
  const lines = [`Chorus is running. There's no screen here, so open this in a browser:`, `  ${openUrl}`];
  if (!host) lines.push(why === 'container' ? 'In a container? Start it with --host 0.0.0.0 and publish the port (-p 127.0.0.1:4318:4318) so your browser can reach it.' : 'In a container or on a server? Start it with --host so another computer\'s browser can reach it.');
  lines.push('The terminal app instead: chorus-cli');
  return lines.join('\n');
}

/** The warning `--host` always prints. */
export const HOST_WARNING = 'Anyone who can reach this port with the address can run agents on this computer.';
