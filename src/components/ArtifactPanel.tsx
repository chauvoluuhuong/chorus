import { useState, useEffect, useRef, type FC } from 'react';
import type { ArtifactItem } from '../types';

interface ArtifactPanelProps {
  artifact: ArtifactItem | null;
  version: number;
  width: number;
  isFullscreen: boolean;
  onWidthChange: (width: number) => void;
  onResetWidth: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
}

export const ArtifactPanel: FC<ArtifactPanelProps> = ({
  artifact,
  version,
  width,
  isFullscreen,
  onWidthChange,
  onResetWidth,
  onToggleFullscreen,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'code' | 'diff'>('preview');
  const [isResizing, setIsResizing] = useState(false);
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current || isFullscreen) return;

      const delta = startXRef.current - e.clientX; // moving left expands panel
      const minW = 320;
      const maxW = Math.max(380, Math.round(window.innerWidth * 0.85));
      const newWidth = Math.min(Math.max(minW, Math.round(startWidthRef.current + delta)), maxW);

      onWidthChange(newWidth);
    };

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        setIsResizing(false);
        document.querySelector('.app')?.classList.remove('art-resizing');
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isFullscreen, onWidthChange]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isFullscreen) return;
    isResizingRef.current = true;
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = panelRef.current ? panelRef.current.getBoundingClientRect().width : width;
    document.querySelector('.app')?.classList.add('art-resizing');
    e.preventDefault();
  };

  const displayName = artifact?.name || 'Artifact Viewer';
  const displayPath = artifact?.path || '.chorus/artifacts';

  return (
    <aside
      ref={panelRef}
      className="panel"
      style={{
        width: isFullscreen ? '100%' : `${width}px`,
        transition: isResizing ? 'none' : undefined,
      }}
      data-test="artifact-canvas-panel"
    >
      {!isFullscreen && (
        <div
          className="resizer"
          id="art-resizer"
          data-test="art-resizer"
          title="Drag to resize panel · Double-click to reset"
          onMouseDown={handleMouseDown}
          onDoubleClick={onResetWidth}
        >
          <div className="resizer-grip" />
        </div>
      )}

      <div className="p-head">
        <div className="t">
          <strong data-test="artifact-title">{displayName}</strong>
          <small data-test="artifact-meta">
            {displayPath} · v{version} · {isFullscreen ? 'fullscreen' : `${width}px`}
          </small>
        </div>

        <div className="seg">
          <button
            type="button"
            aria-pressed={activeTab === 'preview'}
            data-test="artifact-tab-preview"
            onClick={() => setActiveTab('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            aria-pressed={activeTab === 'code'}
            data-test="artifact-tab-code"
            onClick={() => setActiveTab('code')}
          >
            Code
          </button>
          <button
            type="button"
            aria-pressed={activeTab === 'diff'}
            data-test="artifact-tab-diff"
            onClick={() => setActiveTab('diff')}
          >
            Diff
          </button>
        </div>

        <button
          type="button"
          className="btn sm"
          data-test="canvas-reset-width"
          onClick={onResetWidth}
          title="Reset to 580px"
        >
          Reset
        </button>

        <button
          type="button"
          className="btn sm"
          data-test="canvas-fullscreen-btn"
          onClick={onToggleFullscreen}
          title="Toggle fullscreen canvas"
        >
          {isFullscreen ? 'Exit Full' : 'Fullscreen'}
        </button>

        <button
          type="button"
          className="ghost-icon"
          data-test="canvas-close-btn"
          onClick={onClose}
          title="Close panel"
        >
          ✕
        </button>
      </div>

      <div className="p-body" data-test="artifact-body">
        {activeTab === 'preview' ? (
          artifact?.content ? (
            artifact.name.endsWith('.html') ? (
              <iframe
                title="Artifact Preview"
                srcDoc={artifact.content}
                style={{
                  width: '100%',
                  height: '100%',
                  minHeight: '400px',
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  background: '#FFFFFF',
                }}
                sandbox="allow-scripts"
                data-test="artifact-iframe"
              />
            ) : (
              <div className="md-preview">
                <h3>{displayName}</h3>
                <pre>{artifact.content}</pre>
              </div>
            )
          ) : (
            <div style={{ color: 'var(--muted)', textAlign: 'center', padding: '40px 0' }}>
              No artifact content available.
            </div>
          )
        ) : activeTab === 'code' ? (
          <pre className="src" data-test="artifact-source">
            {artifact?.content || '// Empty'}
          </pre>
        ) : (
          <div className="diff-view" data-test="artifact-diff">
            <div className="head-line">--- Previous Version (v{Math.max(1, version - 1)})</div>
            <div className="head-line">+++ Current Version (v{version})</div>
            <div className="add-line">+ {displayName} created with {artifact?.content?.length || 0} bytes</div>
          </div>
        )}
      </div>
    </aside>
  );
};
