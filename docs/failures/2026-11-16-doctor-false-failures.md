# The Doctor's detailed test failed two checks that were not broken

Report: R-PBBYF (sent from the app's Report issue) · 2026-11-16 · fixed in chorus-core `dev` 29f8946, shipped with the next release

## What broke
On Chorus 2.5.1 the detailed test of two CLI versions newer than the tested list ended with "Problem":
- Codex 0.169.0, "A chat resumes with its context": "the resumed run did not remember".
- Antigravity 1.5.9, "The permission prompt is recognised and approved": "the command ran without a permission prompt".

Both CLIs worked. The test was wrong about the first and blind to a setting in the second.

## Why
- **Resume.** Every doctor chat gets a standing note that names a "code word" (it proves that Chorus's instructions reach the
  model). The resume check then said "remember this code word" with another word, and later asked "what was the code word I
  gave you earlier?". With two code words in its context, Codex answered the note's. The chat had resumed: same session id, and
  the second run reused the first run's context.
- **Approval.** The user's Antigravity was in its Auto mode ("edits & safe commands auto-approved"), so it ran the test's
  command without asking, as it was set to do. The check knew only "a prompt appeared" or "the command ran without one".

## How to avoid it
- A check never reuses a word or a role another part of the same chat already uses. The resume check now asks for a fruit.
- A check that depends on the user's own CLI settings says so: when the CLI approves by itself, the approval check is skipped
  with the reason. Chorus does not override the user's mode.
- Judge "did it resume" by more than the model's wording: the session id and the reused context were right all along and were
  in the evidence.

## How it was found
The report carried the two failing checks and the evidence folders; the stream of the second run showed the model answering with the
standing note's word, and the saved screen showed the Auto mode line.
