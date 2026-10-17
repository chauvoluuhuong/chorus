// Splits keyboard input into "bytes for the agent" and Chorus menu commands (docs/phase4.md §2).
//
// The menu key (default Ctrl+Space = NUL byte) opens the Chorus menu; the next key picks a command.
// Pressing the menu key twice sends it to the agent. Bracketed pastes are never scanned.

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
  private menuKey: string;

  constructor(emit: (e: InputEvent) => void, menuKey = '\x00') {
    this.emit = emit;
    this.menuKey = menuKey;
  }

  feed(chunk: string) {
    if (this.capture) {
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
        if (ch === this.menuKey) {
          this.menuOpen = false;
          this.emit({ type: 'menu-close' });
          this.emit({ type: 'pass', data: this.menuKey }); // double press = literal key
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
      if (s[i] === this.menuKey) {
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
