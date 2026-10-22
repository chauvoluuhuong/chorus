// Files dropped on a chat (docs/phase5.md §8.3, docs/integrations/file-drop.md): the path goes into the agent's input the way a
// terminal sends a dropped file, so each agent does its own thing with it (Claude and Codex attach images). A copy, when asked
// for or when there is no path, goes into the chat's attachments folder, inside the project: no "read this file?" prompt.
import fs from 'node:fs';
import path from 'node:path';

/** Backslash before spaces and shell characters, like Terminal.app and iTerm2 do for a dropped file. */
export function escapeLikeTerminal(file: string): string {
  return file.replace(/([ \t\\'"()&;$`!*?[\]{}|<>#])/g, '\\$1');
}

/** What a terminal sends for a drop: each path escaped, a space after each, inside bracketed-paste markers when the agent asked for them. */
export function dropText(files: string[], bracketed: boolean): string {
  const text = files.map(f => escapeLikeTerminal(f) + ' ').join('');
  return bracketed ? `\x1b[200~${text}\x1b[201~` : text;
}

/** A file name safe to write: no folders, no control characters, not empty, not hidden by accident. */
export function safeName(name: string): string {
  const base = path.basename(String(name).replace(/\\/g, '/')).replace(/[\x00-\x1f/]/g, '').trim();
  return base && base !== '.' && base !== '..' ? base : 'file';
}

/** The first free name in `dir`: "shot.png", then "shot (2).png", "shot (3).png" … */
export function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const n = i === 1 ? name : `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, n))) return n;
  }
}

/** Copies a file (or bytes with a name) into `dir` under a free name; returns the new path. */
export function copyInto(dir: string, from: { path: string } | { name: string; bytes: Buffer }): string {
  fs.mkdirSync(dir, { recursive: true });
  const name = freeName(dir, safeName('path' in from ? from.path : from.name));
  const to = path.join(dir, name);
  if ('path' in from) fs.copyFileSync(from.path, to);
  else fs.writeFileSync(to, from.bytes);
  return to;
}
