# Skills: where each CLI loads them, and how Chorus syncs them

| | |
|---|---|
| **Status** | ✅ Claude Code 2.1.284, Codex 0.163.0 and agy 1.4.0 verified (probe + smoke proof) |
| **Probe** | `node tools/probe/skills-probe.mjs [claude codex agy]` writes one marker skill into each candidate folder and asks for it. Results in `fixtures/skills/` |
| **Proof** | `npm run smoke -- --phase 2` (marker skill synced from `.chorus/skills`, used by each CLI) |

Legend: ✅ verified by running it · 📄 docs only · ❓ unknown.

## 1. Where project skills are discovered

| CLI | Native project folders | Native user folders | Source of the evidence |
|---|---|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md` only | `~/.claude/skills/` | ✅ the `system/init` event has a `skills` array: it listed `probe-claude` (`.claude/skills`) and not `probe-agents` (`.agents/skills`) |
| Codex | `.agents/skills/`, `.codex/skills/` | `~/.agents/skills/`, `~/.codex/skills/` (+ `~/.codex/skills/.system/` defaults) | ✅ Codex lists its "skill roots" in the first developer message of every session (`rollout-*.jsonl`) and names both project folders |
| agy | `.agents/skills/` (also the older `.agent/skills/`) | `~/.gemini/antigravity-cli/builtin/skills/` (defaults), `~/.gemini/config` | ✅ first tool call opens the `SKILL.md` directly; shipped doc `builtin/skills/agy-customizations/docs/skills.md` says `<customization root>/skills/<name>/SKILL.md`, e.g. `.agents/skills/` |

`.agents/skills/` is shared by Codex and agy, so Chorus writes **two** targets: `.claude/skills` and
`.agents/skills`.

Other folders (`.claude/skills` for Codex/agy, `.gemini/skills`, …) are not native. agy and Codex
may still find them because they have file tools (`find`, `rg`), but that is the model searching,
not the CLI loading a skill, and it is not reliable. Don't depend on it.

## 2. Format (same in all three)

- A directory per skill with `SKILL.md`; optional `scripts/`, `references/`, `examples/`, `resources/`. ✅ (agy doc, Codex defaults)
- `SKILL.md` starts with YAML frontmatter: `name` (lowercase-hyphen) and `description`
  (what it does **and when to use it**; this is what the agent matches on). ✅
- Extra files are reached through relative links; the agent reads them with its file tools. ✅

## 3. How the agent uses a skill

- Automatic: skill names and descriptions are put in the model's context (Codex: a `<skills_instructions>`
  developer message with root table and one line per skill). The model then reads `SKILL.md` with a
  tool: Codex runs `cat <root>/<name>/SKILL.md`, agy calls `view_file`. ✅
- So a skill is "used" when the transcript shows that read. Chorus's smoke test asserts the marker
  from the skill body in the answer **and** a tool call mentioning the skill. ✅
- Claude Code: the model calls its `Skill` tool (`{"skill": "<name>"}`), also available as `/name`; the `init` event lists loaded skills in `skills` and `slash_commands`. ✅ Symlinked skill folders work (smoke phase 2).

## 4. Default skills (avoid name clashes)

| CLI | Where | Names seen |
|---|---|---|
| Codex | `~/.codex/skills/.system/` | `imagegen`, `openai-docs`, `review-agent`, `skill-creator`, `skill-installer`; plugins add more under `~/.codex/plugins/cache/` |
| agy | `~/.gemini/antigravity-cli/builtin/skills/` | `agy-customizations`, `antigravity_guide`, `automation`, `generative_ui`, `migrate-workflows`, `permissioned-github`, `plugin`, `run-workflow`, `ui-plugin-navigation` |
| Claude Code | bundled (not files) | see `init.skills` of a run in a folder with no skills |

## 5. Sync design (implemented in `src/core/skills.ts`)

- **Source of truth:** `<project>/.chorus/skills/<name>/SKILL.md` (+ extra files).
- **Write-out:** for each skill, a symlink `.claude/skills/<name>` and `.agents/skills/<name>`
  → `../../.chorus/skills/<name>`. Symlinked skill folders work in Codex and agy. ✅ (Claude ❓)
  Where symlinks fail, Chorus copies the folder and adds a `.chorus-managed` marker file.
- **Managed marker:** an entry is Chorus's if it is a symlink into `.chorus/skills` or a folder with
  `.chorus-managed`. Nothing else is ever overwritten or removed; a same-name user skill is
  reported as a conflict and skipped. ✅ (L2 test)
- **Removal:** deleting a skill from `.chorus/skills` removes its managed entries on the next sync. ✅
- **Git:** written entries are added to `.git/info/exclude` so the user's repo status stays clean.
- **Project scope only.** Writing into `~/.claude` / `~/.agents` / `~/.codex` would edit the user's
  global CLI setup (CLAUDE.md rule 4); user-scope sync can be an opt-in later.
- **Fallback (no native loading or a CLI we can't write for):** MCP tools `list_skills` and
  `get_skill(name)` return the same skills from `.chorus/skills`. ✅ (L2 test). A first-prompt index or
  an `AGENTS.md` pointer is possible but not needed so far.

## 6. Gotchas

1. Model behaviour is not deterministic: with five skills in different folders Codex and Claude
   Haiku sometimes answered "can't find" for a skill that was loaded natively. Judge native loading by
   the CLI's own skill list (Codex roots table, Claude `init.skills`, agy first tool call), not by one
   answer. ✅
2. Skill names must be unique across `.claude/skills` and `.agents/skills`; use distinct names from
   the defaults in §4.
3. Folded descriptions (`description: >-`) are valid YAML; Chorus's parser handles them. ✅
