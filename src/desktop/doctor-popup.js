// When the Doctor popup opens by itself (first launch, or after Chorus or a CLI was updated: docs/doctor.md §6.1): only when the
// short check did not pass (owner, 2026-11-12). Passed: at least one agent is Ready and no installed agent needs you (not logged
// in, a version new to Chorus, a failed check). An agent that is not installed does not count.

/** null while the short check has not answered yet; then whether it passed. */
export function shortCheckPassed(doctor) {
  if (!doctor || doctor.checking || !Array.isArray(doctor.agents)) return null;
  const installed = doctor.agents.filter(a => a.state !== 'missing');
  return installed.some(a => a.state === 'ready') && installed.every(a => a.state === 'ready');
}
