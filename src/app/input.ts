// Splits keyboard input into "bytes for the agent" and Chorus menu commands (docs/phase4.md §2).
//
// The menu key opens the Chorus menu; the next key picks a command. Pressing the menu key twice sends it to the agent.
// Bracketed pastes are never scanned.
//
// Default menu keys: Ctrl+\ (byte 0x1c) and Ctrl+Space (NUL). macOS grabs Ctrl+Space for "switch input source" in many
// setups, so the terminal never sees it; Ctrl+\ always arrives. CHORUS_MENU_KEY=ctrl+b (or ctrl+space, ctrl+\) replaces both.

export interface MenuKeys {
  keys: string[];
  /** how the hint on screen names the key */
  label: string;
}

export function parseMenuKeys(spec = process.env.CHORUS_MENU_KEY): MenuKeys {
  if (!spec) return { keys: ['\x1c', '\x00'], label: '⌃\\' };
  const m = spec.trim().toLowerCase().match(/^(?:ctrl|\^|c-)\+?(.+)$/);
  const name = m?.[1] ?? '';
  if (name === 'space' || name === '@') return { keys: ['\x00'], label: '⌃Space' };
  if (name === 'backslash' || name === '\\') return { keys: ['\x1c'], label: '⌃\\' };
  if (name.length === 1 && /[a-z\]^_]/.test(name)) return { keys: [String.fromCharCode(name.charCodeAt(0) & 0x1f)], label: `⌃${name.toUpperCase()}` };
  return { keys: ['\x1c', '\x00'], label: '⌃\\' }; // not understood: keep the defaults
}

export type InputEvent =
  | { type: 'pass'; data: string }
  | { type: 'menu-open' }
  | { type: 'menu-close' }
  | { type: 'menu-move'; delta: -1 | 1 }
  | { type: 'menu-enter' }
  | { type: 'menu-key'; key: string }
  | { type: 'key'; key: string }; // capture mode: panes and dialogs read keys themselves

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class InputRouter {
  menuOpen = false;
  /** when true every key is reported as {type:'key'} instead of going to the agent (panes, dialogs) */
  capture = false;
  private inPaste = false;
  private pending = '';

  private emit: (e: InputEvent) => void;
  private menuKeys: string[];

  constructor(emit: (e: InputEvent) => void, menuKeys: string | string[] = parseMenuKeys().keys) {
    this.emit = emit;
    this.menuKeys = typeof menuKeys === 'string' ? [menuKeys] : menuKeys;
  }

  feed(chunk: string) {
    if (this.capture && !this.menuOpen) {
      // the menu key works on every screen (panes, dialogs): it opens the menu over them
      if (this.menuKeys.includes(chunk)) {
        this.menuOpen = true;
        this.emit({ type: 'menu-open' });
        return;
      }
      const re = /^(?:\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b|[\s\S])/;
      for (let rest = chunk; rest; ) {
        const m = rest.match(re)![0];
        this.emit({ type: 'key', key: m });
        rest = rest.slice(m.length);
      }
      return;
    }
    let s = this.pending + chunk;
    this.pending = '';
    let pass = '';
    const flush = () => {
      if (pass) this.emit({ type: 'pass', data: pass });
      pass = '';
    };
    for (let i = 0; i < s.length; ) {
      if (this.inPaste) {
        const end = s.indexOf(PASTE_END, i);
        if (end < 0) {
          // keep a possible partial end marker for the next chunk
          const keep = partial(s.slice(i), PASTE_END);
          pass += s.slice(i, s.length - keep);
          this.pending = s.slice(s.length - keep);
          i = s.length;
        } else {
          pass += s.slice(i, end + PASTE_END.length);
          this.inPaste = false;
          i = end + PASTE_END.length;
        }
        continue;
      }
      if (this.menuOpen) {
        // menu mode: one key at a time; escape sequences are arrows
        if (s[i] === '\x1b') {
          const m = s.slice(i).match(/^\x1b(?:\[|O)([AB])/);
          if (m) {
            this.emit({ type: 'menu-move', delta: m[1] === 'A' ? -1 : 1 });
            i += m[0].length;
            continue;
          }
          if (s.slice(i).length < 3 && s.slice(i).startsWith('\x1b') && s.length - i > 1) {
            this.pending = s.slice(i);
            break;
          }
          this.close();
          i += 1;
          continue;
        }
        const ch = s[i++];
        if (this.menuKeys.includes(ch)) {
          this.menuOpen = false;
          this.emit({ type: 'menu-close' });
          this.emit({ type: 'pass', data: ch }); // double press = literal key
        } else if (ch === '\r' || ch === '\n') {
          this.menuOpen = false; // a command ends the menu
          this.emit({ type: 'menu-enter' });
        } else {
          this.menuOpen = false;
          this.emit({ type: 'menu-key', key: ch });
        }
        continue;
      }
      if (s.startsWith(PASTE_START, i)) {
        this.inPaste = true;
        pass += PASTE_START;
        i += PASTE_START.length;
        continue;
      }
      if (s[i] === '\x1b' && PASTE_START.startsWith(s.slice(i)) && s.length - i < PASTE_START.length) {
        this.pending = s.slice(i); // maybe the start of a paste marker
        break;
      }
      if (this.menuKeys.includes(s[i])) {
        flush();
        this.menuOpen = true;
        this.emit({ type: 'menu-open' });
        i++;
        continue;
      }
      pass += s[i++];
    }
    flush();
  }

  /** Opens the menu from a click on the top bar's button (the same as pressing the menu key). */
  open() {
    if (!this.menuOpen) {
      this.menuOpen = true;
      this.emit({ type: 'menu-open' });
    }
  }

  close() {
    if (this.menuOpen) {
      this.menuOpen = false;
      this.emit({ type: 'menu-close' });
    }
  }
}

function partial(s: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) if (s.endsWith(marker.slice(0, n))) return n;
  return 0;
}
