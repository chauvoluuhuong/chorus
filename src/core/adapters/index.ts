import type { Adapter, AgentId } from '../types.ts';
import { agy } from './agy.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';

export const adapters: Record<AgentId, Adapter> = { claude, codex, agy };
export { agy, claude, codex };

/** Last CLI versions the fixtures were captured on (docs/integrations). Newer versions still parse, with a warning. */
export const VERIFIED_VERSION: Record<AgentId, string> = { claude: '2.1.301', codex: '0.163.0', agy: '1.4.0' };

export function versionWarning(agent: AgentId, version: string | undefined): string | undefined {
  if (!version) return undefined;
  const num = (v: string) => v.split(/[.\-]/).map(n => parseInt(n, 10) || 0);
  const [a, b] = [num(version), num(VERIFIED_VERSION[agent])];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return `${agent} ${version} is newer than the last verified ${VERIFIED_VERSION[agent]}; re-run tools/probe and check docs/integrations/${agent}.md`;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return undefined;
  }
  return undefined;
}
