import { useState, useRef, type FC, type KeyboardEvent, type ChangeEvent } from 'react';
import type { AgentId, SkillBundle, PromptEnvelope } from '../types';
import { MentionPopover, type MentionItem } from './MentionPopover';
import { SlashPopover } from './SlashPopover';

interface ComposerDockProps {
  selectedAgent: AgentId;
  selectedModel: string;
  autonomousMode: boolean;
  ptyConnected: boolean;
  skills: SkillBundle[];
  onToggleAutonomous: () => void;
  onSelectAgent: (agent: AgentId) => void;
  onSubmitPrompt: (prompt: string, envelope: PromptEnvelope) => void;
  onStopPty: () => void;
}

export const ComposerDock: FC<ComposerDockProps> = ({
  selectedAgent,
  selectedModel,
  autonomousMode,
  ptyConnected,
  skills,
  onToggleAutonomous,
  onSelectAgent,
  onSubmitPrompt,
  onStopPty,
}) => {
  const [text, setText] = useState('');
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionPos, setMentionPos] = useState<number>(0);

  const [showSlash, setShowSlash] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashPos, setSlashPos] = useState<number>(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart || 0;
    setText(val);

    // Analyze character preceding or around cursor
    const textBeforeCursor = val.slice(0, cursor);
    const lastAt = textBeforeCursor.lastIndexOf('@');
    const lastSlash = textBeforeCursor.lastIndexOf('/');

    // Check for @ mention
    if (lastAt !== -1 && (lastAt === 0 || /\s/.test(textBeforeCursor[lastAt - 1]))) {
      const q = textBeforeCursor.slice(lastAt + 1);
      if (!/\s/.test(q)) {
        setShowMention(true);
        setMentionQuery(q);
        setMentionPos(lastAt);
        setShowSlash(false);
        return;
      }
    }
    setShowMention(false);

    // Check for / slash command
    if (lastSlash !== -1 && (lastSlash === 0 || /\s/.test(textBeforeCursor[lastSlash - 1]))) {
      const q = textBeforeCursor.slice(lastSlash + 1);
      if (!/\s/.test(q)) {
        setShowSlash(true);
        setSlashQuery(q);
        setSlashPos(lastSlash);
        return;
      }
    }
    setShowSlash(false);
  };

  const handleSelectMention = (item: MentionItem) => {
    const before = text.slice(0, mentionPos);
    const cursor = textareaRef.current?.selectionStart || text.length;
    const after = text.slice(cursor);
    const newText = `${before}@${item.path} ${after}`;
    setText(newText);
    setShowMention(false);

    setTimeout(() => {
      textareaRef.current?.focus();
      const newCursor = (before + '@' + item.path + ' ').length;
      textareaRef.current?.setSelectionRange(newCursor, newCursor);
    }, 0);
  };

  const handleSelectSlash = (command: string) => {
    const before = text.slice(0, slashPos);
    const cursor = textareaRef.current?.selectionStart || text.length;
    const after = text.slice(cursor);
    const newText = `${before}${command} ${after}`;
    setText(newText);
    setShowSlash(false);

    setTimeout(() => {
      textareaRef.current?.focus();
      const newCursor = (before + command + ' ').length;
      textareaRef.current?.setSelectionRange(newCursor, newCursor);
    }, 0);
  };

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Parse context files (@path)
    const contextFiles: string[] = [];
    const contextArtifacts: string[] = [];
    const atMatches = trimmed.matchAll(/@([^\s]+)/g);
    for (const match of atMatches) {
      const target = match[1];
      if (target.includes('.chorus/artifacts') || target.endsWith('.html')) {
        contextArtifacts.push(target);
      } else {
        contextFiles.push(target);
      }
    }

    // Parse skills (/command)
    const onDemandSkills: string[] = [];
    const slashMatches = trimmed.matchAll(/\/([a-zA-Z0-9_\-]+)/g);
    for (const match of slashMatches) {
      const cmd = `/${match[1]}`;
      const foundSkill = skills.find(s => s.command === cmd || s.name === match[1]);
      if (foundSkill) {
        onDemandSkills.push(
          foundSkill.content ||
            `# ${foundSkill.name} Skill\n${foundSkill.description}\nCommand: ${foundSkill.command}`,
        );
      }
    }

    const envelope: PromptEnvelope = {
      turn_id: `turn-${Date.now()}`,
      target_engine: selectedAgent,
      user_prompt: trimmed,
      context_files: contextFiles,
      context_artifacts: contextArtifacts,
      on_demand_skills: onDemandSkills,
      shared_memory_budget_tokens: 4000,
    };

    onSubmitPrompt(trimmed, envelope);
    setText('');
    setShowMention(false);
    setShowSlash(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (showMention || showSlash) {
        // let selection resolve or fall through
      } else {
        e.preventDefault();
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      setShowMention(false);
      setShowSlash(false);
    }
  };

  return (
    <div className="dock">
      <div className="composer">
        {showMention && (
          <MentionPopover
            query={mentionQuery}
            onSelect={handleSelectMention}
            onClose={() => setShowMention(false)}
          />
        )}

        {showSlash && (
          <SlashPopover
            query={slashQuery}
            skills={skills}
            onSelect={handleSelectSlash}
            onClose={() => setShowSlash(false)}
          />
        )}

        <textarea
          ref={textareaRef}
          data-test="composer-input"
          rows={2}
          placeholder="Message Claude, ask questions, type @ for files/artifacts or / for skills..."
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />

        <div className="c-row">
          {/* Quick @ mention trigger */}
          <button
            type="button"
            className="c-icon"
            data-test="composer-at-btn"
            title="Mention file, folder or artifact (@)"
            onClick={() => {
              setShowMention(true);
              setMentionQuery('');
              setMentionPos(text.length);
              setShowSlash(false);
            }}
          >
            @
          </button>

          {/* Quick / slash skill trigger */}
          <button
            type="button"
            className="c-icon"
            data-test="composer-slash-btn"
            title="Use project skill or command (/)"
            onClick={() => {
              setShowSlash(true);
              setSlashQuery('');
              setSlashPos(text.length);
              setShowMention(false);
            }}
          >
            /
          </button>

          {/* Autonomous Mode Toggle */}
          <button
            type="button"
            className={`pill-toggle ${autonomousMode ? 'on-warn' : ''}`}
            onClick={onToggleAutonomous}
            data-test="toggle-skip-permissions"
            title="Toggle autonomous permissions bypass"
          >
            <span className="switch-mini">
              <span className="knob" />
            </span>
            <span>{autonomousMode ? '⚡ auto-approve' : 'Safe mode'}</span>
          </button>

          {/* Handoff Trigger Button */}
          <button
            type="button"
            className="btn-handoff"
            data-test="handoff-trigger-btn"
            title="Switch to another engine with context handoff"
          >
            ⇄ Hand off
          </button>

          {/* Agent & Model Picker Button */}
          <button
            type="button"
            className="picker"
            data-test="agent-picker-btn"
            onClick={() => {
              const nextAgent: AgentId =
                selectedAgent === 'claude' ? 'agy' : selectedAgent === 'agy' ? 'codex' : 'claude';
              onSelectAgent(nextAgent);
            }}
          >
            <span className={`mark xs m-${selectedAgent}`}>{selectedAgent[0].toUpperCase()}</span>
            <span className="lbl">{selectedAgent.toUpperCase()}</span>
            <span className="mdl">{selectedModel}</span>
          </button>

          {/* Submit / Stop Buttons */}
          {ptyConnected ? (
            <button
              type="button"
              className="send stop"
              data-test="composer-stop"
              onClick={onStopPty}
              title="Send SIGINT (Ctrl+C)"
            >
              ⏹
            </button>
          ) : (
            <button
              type="button"
              className="send"
              data-test="composer-submit"
              onClick={handleSubmit}
              title="Send Prompt"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
