# Dropped files per CLI: what a pasted file path does

| | |
|---|---|
| **Status** | ✅ verified in the interactive screen 2026-10-22: claude 2.1.308, codex 0.163.0, agy 1.4.5 |
| **Probe** | `node tools/probe/drop-probe.mjs <cli>` (Claude also with `--default-permissions`) · evidence `fixtures/<cli>/<version>/drop*/` |
| **Used by** | desktop drag-and-drop (`docs/phase5.md` §8.3): `src/core/drop.ts`, `Controller.dropFiles`, `desktop/src-tauri/src/main.rs` |

How the probe sends a file: exactly what Terminal.app or iTerm2 send when you drop a file on them. The path is
backslash-escaped (`drop\ shot.png`), followed by one space, inside bracketed-paste markers (`ESC[200~ … ESC[201~`); all three
agents turn bracketed paste on. The files sit outside the agent's folder (like `~/Downloads`) and have a space in their name.
Then the probe asks a question that only the file can answer: the colour of a red PNG, a word printed in a PDF.

| | Claude Code | Codex | agy |
|---|---|---|---|
| Bracketed paste on | ✅ | ✅ | ✅ |
| Image path (`.png`) | ✅ becomes `[Image #1]` in the input; the model sees the image ("Red") | ✅ becomes `[Image #1]`; the model sees it ("Red") | ✅ stays path text; the agent opens it with its file tool ("Explored 1 file") and answers "Red" |
| PDF path | ✅ stays path text; read with `Read` ("PINEAPPLE") | ✅ stays path text; read with shell (`pdftotext` and Python's `fitz` were missing, `strings` worked on the probe's plain PDF: a real, compressed PDF would likely fail) | ✅ stays path text; read with `ReadFile` |
| File outside the folder: asks first? | ✅ default mode: `Read file … Do you want to proceed?` with "Yes, allow reading from <folder> during this session". Auto mode (this Mac's own default) did not ask. The image itself needed no prompt when the model used the attachment, but in one run the model also called `Read` on it and was asked | ✅ no prompt (the sandbox lets it read anywhere) | ✅ `File access · Reason: outside workspace · Allow access to this file?` (also "always allow non-workspace access") |
| Escaped spaces understood | ✅ | ✅ | ✅ |

What this means for Chorus:
- Insert the path the way a terminal does and send it as a paste: each agent then does its own thing (Claude and Codex attach
  images). Nothing to translate per agent.
- A file outside the chat's folder costs an approval in Claude (default mode) and agy. Copying it into the chat's folder first
  (`<project>/.chorus/threads/<id>/attachments/`) avoids that; the prompt then lands in Chorus's approvals inbox otherwise.
- Codex reads PDFs only through whatever command-line tools the machine has.

Not checked: several files in one drop, folders, `file://` URLs, very large files, the terminal app's own drop (the terminal
pastes the path, Chorus passes pastes through unchanged: `src/app/input.ts`).
