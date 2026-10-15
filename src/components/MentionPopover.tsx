import { useState, useEffect, type FC } from 'react';

export interface MentionItem {
  type: 'file' | 'folder' | 'artifact';
  path: string;
  name: string;
  description?: string;
  badge?: string;
}

interface MentionPopoverProps {
  query: string;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
  customFiles?: string[];
  customFolders?: string[];
  artifacts?: { name: string; path: string }[];
}

export const MentionPopover: FC<MentionPopoverProps> = ({
  query,
  onSelect,
  onClose,
  customFiles = [],
  customFolders = [],
  artifacts = [],
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'files' | 'folders' | 'artifacts'>('all');
  const [scannedFiles, setScannedFiles] = useState<string[]>(customFiles);
  const [scannedFolders, setScannedFolders] = useState<string[]>(customFolders);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    // Attempt scan from workspace API
    fetch('/api/fs/scan')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data) {
          if (data.files && customFiles.length === 0) setScannedFiles(data.files);
          if (data.folders && customFolders.length === 0) setScannedFolders(data.folders);
        }
      })
      .catch(() => {});
  }, [customFiles.length, customFolders.length]);

  // Combine default items with scanned items
  const allItems: MentionItem[] = [];

  // Add sample files if empty
  const fileList = scannedFiles.length > 0 ? scannedFiles : [
    'src/components/OrderForm.tsx',
    'src/App.tsx',
    'package.json',
  ];

  fileList.forEach(f => {
    allItems.push({
      type: 'file',
      path: f,
      name: f.split('/').pop() || f,
      description: f,
      badge: 'File',
    });
  });

  const folderList = scannedFolders.length > 0 ? scannedFolders : [
    'src/components',
    'src',
    'documents',
  ];

  folderList.forEach(f => {
    allItems.push({
      type: 'folder',
      path: f,
      name: f.split('/').pop() || f,
      description: f,
      badge: 'Folder',
    });
  });

  const artifactList = artifacts.length > 0 ? artifacts : [
    { name: 'checkout-v2.html', path: '.chorus/artifacts/claude/thread-1/checkout-v2.html' },
  ];

  artifactList.forEach(a => {
    allItems.push({
      type: 'artifact',
      path: a.path,
      name: a.name,
      description: a.path,
      badge: 'Artifact',
    });
  });

  const filtered = allItems.filter(item => {
    if (activeTab === 'files' && item.type !== 'file') return false;
    if (activeTab === 'folders' && item.type !== 'folder') return false;
    if (activeTab === 'artifacts' && item.type !== 'artifact') return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      return item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="mention-popover" data-test="mention-popover">
      <div className="mention-tabs">
        <button
          className={`mention-tab ${activeTab === 'all' ? 'active' : ''}`}
          data-test="mention-tab-all"
          onClick={() => setActiveTab('all')}
        >
          All
        </button>
        <button
          className={`mention-tab ${activeTab === 'files' ? 'active' : ''}`}
          data-test="mention-tab-files"
          onClick={() => setActiveTab('files')}
        >
          📁 Files
        </button>
        <button
          className={`mention-tab ${activeTab === 'folders' ? 'active' : ''}`}
          data-test="mention-tab-folders"
          onClick={() => setActiveTab('folders')}
        >
          📂 Folders
        </button>
        <button
          className={`mention-tab ${activeTab === 'artifacts' ? 'active' : ''}`}
          data-test="mention-tab-artifacts"
          onClick={() => setActiveTab('artifacts')}
        >
          🎨 Artifacts
        </button>
      </div>

      <div className="mention-list" data-test="mention-list">
        {filtered.length === 0 ? (
          <div style={{ padding: '8px 10px', color: 'var(--muted)', fontSize: 13 }}>
            No matching items found
          </div>
        ) : (
          filtered.map(item => (
            <button
              key={`${item.type}-${item.path}`}
              className="mention-item"
              data-test={`mention-item-${item.path}`}
              onClick={() => onSelect(item)}
            >
              <span className="icon">
                {item.type === 'file' ? '📄' : item.type === 'folder' ? '📁' : '🎨'}
              </span>
              <div className="info">
                <strong>{item.path}</strong>
                {item.description && <small>{item.description}</small>}
              </div>
              {item.badge && <span className="mention-badge">{item.badge}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
};
