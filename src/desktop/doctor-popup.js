// When the Doctor popup opens by itself (first launch, or after Chorus or a CLI was updated: docs/doctor.md §6.1): only when the
// short check did not pass (owner, 2026-11-12). Passed: at least one agent can be used and no installed agent needs you (not
// logged in, a failed check). A version new to Chorus can be used: its detailed test is only suggested, on the Doctor page, so it
// passes too (owner, 2026-11-13). An agent that is not installed does not count.

/** null while the short check has not answered yet; then whether it passed. */
export function shortCheckPassed(doctor) {
  if (!doctor || doctor.checking || !Array.isArray(doctor.agents)) return null;
  const installed = doctor.agents.filter(a => a.state !== 'missing');
  const usable = a => a.state === 'ready' || a.state === 'untested';
  return installed.some(usable) && installed.every(usable);
}
