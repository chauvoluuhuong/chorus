# README rewrite; agent files out of the repo

Decided by the owner on 2026-10-28.

## Outcome
- `AGENTS.md` and `CLAUDE.md` are no longer in the repository (not tracked, ignored by `.gitignore`); each contributor keeps
  their own local copy for their agents. Git history still holds the old versions.
- `README.md` leads with the desktop app and the install commands, explains the branch and release flow, and has a
  Contributing section that stands without those files.

## Approach
- Chosen: `git rm --cached` both files and ignore them. The owner's local copies stay, so sessions here keep their rules.
  Rejected: deleting them from disk (loses the standing rules), a private companion repo (more to maintain for now).
- Links to the files in `docs/map.md`, `docs/roadmap.md`, `.github/workflows/release.yml` and a code comment now point at
  `README.md` / `docs/map.md`.

## Test
`npm test` and `npm run typecheck` (comment-only code change); `git ls-files` shows neither file; no link to them is left.

## Risks
- The standing decisions and rules exist only in local copies from now on; a fresh clone has none. The README states the
  rules a contributor needs. Docs that say "CLAUDE.md rule N" are historical text.
