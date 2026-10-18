// Models offered in the new-thread form. "default" always comes first and means: pass no model flag.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homes } from '../core/launch.ts';
import type { AgentId } from '../core/types.ts';

const CLAUDE = ['default', 'sonnet', 'opus', 'haiku']; // aliases `claude --model` accepts
const DAY = 24 * 3600 * 1000;

function codexModels(): string[] {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(homes.codex(), 'models_cache.json'), 'utf8'));
    return (d.models as { slug: string; visibility?: string; priority?: number }[])
      .filter(m => m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map(m => m.slug);
  } catch {
    return [];
  }
}

/** `agy models` prints "<id>\t<name>" per line; it calls the service, so the answer is cached for a day. */
function agyModels(): string[] {
  const cache = path.join(os.tmpdir(), 'chorus-agy-models.json');
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (Date.now() - c.at < DAY && c.models.length) return c.models;
  } catch {
    /* no cache yet */
  }
  const r = spawnSync('agy', ['models'], { encoding: 'utf8', timeout: 8000 });
  const models = (r.stdout ?? '')
    .split('\n')
    .map(l => l.split('\t')[0].trim())
    .filter(id => /^[\w.\-]+$/.test(id) && !/^fetching/i.test(id));
  if (models.length) fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), models }));
  return models;
}

export function modelsFor(agent: AgentId): string[] {
  const list = agent === 'claude' ? CLAUDE.slice(1) : agent === 'codex' ? codexModels() : agyModels();
  return ['default', ...list];
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']; // `claude --effort` and `agy --effort` (their --help)

/**
 * Effort (reasoning level) choices for a new chat: "default" passes no flag. Claude and agy take the five levels their --help
 * lists. Codex lists the levels per model in its own cache, so the list follows the chosen model (the first listed model when
 * the model is "default").
 */
export function effortsFor(agent: AgentId, model?: string): string[] {
  if (agent !== 'codex') return ['default', ...LEVELS];
  try {
    const d = JSON.parse(fs.readFileSync(path.join(homes.codex(), 'models_cache.json'), 'utf8')) as { models: { slug: string; visibility?: string; priority?: number; supported_reasoning_levels?: { effort: string }[] }[] };
    const listed = d.models.filter(m => m.visibility === 'list').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    const m = (model && model !== 'default' ? listed.find(x => x.slug === model) : undefined) ?? listed[0];
    const levels = (m?.supported_reasoning_levels ?? []).map(l => l.effort);
    return ['default', ...(levels.length ? levels : LEVELS)];
  } catch {
    return ['default', ...LEVELS];
  }
}
