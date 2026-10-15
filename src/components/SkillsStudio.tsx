import { useState, type FC } from 'react';
import type { SkillBundle } from '../types';

interface SkillsStudioProps {
  skills: SkillBundle[];
  onSyncSkills: () => Promise<void>;
  onToggleSkill: (skillId: string, active: boolean) => Promise<void>;
  toastMsg: string | null;
}

export const SkillsStudio: FC<SkillsStudioProps> = ({
  skills,
  onSyncSkills,
  onToggleSkill,
  toastMsg,
}) => {
  const [search, setSearch] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);

  const filtered = skills.filter(s => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.command.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.origin.toLowerCase().includes(q)
    );
  });

  const handleSync = async () => {
    setIsSyncing(true);
    await onSyncSkills();
    setIsSyncing(false);
  };

  return (
    <div className="pg" data-test="skills-studio-page">
      <div className="pg-inner">
        <div className="pg-title">
          <div>
            <h2>Skills Studio</h2>
            <p>Unified cross-engine skill bundles (.agents/skills, .claude/skills, .codex/skills)</p>
          </div>
          <button
            type="button"
            className="btn btn-dark"
            data-test="sync-skills-btn"
            disabled={isSyncing}
            onClick={handleSync}
          >
            {isSyncing ? 'Scanning...' : 'Sync skills'}
          </button>
        </div>

        <input
          type="text"
          className="search"
          data-test="skill-search-input"
          placeholder="Search skills by name, command, or origin..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <div className="card">
          <ul className="skills" data-test="skills-list">
            {filtered.length === 0 ? (
              <li style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)' }}>
                No skills found. Click "Sync skills" to scan workspace directories.
              </li>
            ) : (
              filtered.map(s => (
                <li key={s.id} className="skill" data-test={`skill-row-${s.id}`}>
                  <div>
                    <div className="sk-name">
                      <strong>{s.name}</strong>
                      <code>{s.command}</code>
                    </div>
                    <p className="sk-desc">{s.description}</p>
                    <div className="sk-meta">
                      <span className="chiplet">{s.origin}</span>
                      <span>{s.path}</span>
                    </div>
                  </div>

                  <div className="sk-side">
                    <label className="switch">
                      <input
                        type="checkbox"
                        data-test={`skill-toggle-${s.id}`}
                        checked={s.active}
                        onChange={e => onToggleSkill(s.id, e.target.checked)}
                      />
                      <span />
                    </label>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>

        {toastMsg && (
          <div className="toast" data-test="toast-notification">
            {toastMsg}
          </div>
        )}
      </div>
    </div>
  );
};
