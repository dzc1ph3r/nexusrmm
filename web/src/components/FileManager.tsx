import { useState, useCallback, useRef, useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  Folder,
  File,
  ChevronLeft,
  ChevronRight,
  Upload,
  Trash2,
  Plus,
  RefreshCw,
  MoreVertical,
  Grid,
  List,
  Home,
  ArrowUp,
} from 'lucide-react';
import { api, FileInfo } from '../services/api';
import toast from 'react-hot-toast';

interface FileManagerProps {
  agentId: string;
  sessionId: string;
  onClose: () => void;
}

export function FileManager({ agentId, sessionId, onClose }: FileManagerProps) {
  const { send, on } = useWebSocket();
  const [currentPath, setCurrentPath] = useState('/');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [showUpload, setShowUpload] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [renameState, setRenameState] = useState<{ name: string; newName: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pathHistory = useRef<string[]>(['/']);
  const historyIndex = useRef(0);

  useEffect(() => {
    loadDirectory(currentPath);
    const cleanup = on('file.list' as any, handleFileList);
    send('session.join' as any, { session_id: sessionId, agent_id: agentId });
    return cleanup;
  }, [agentId, sessionId, send, on, currentPath]);

  const handleFileList = useCallback((message: { payload: unknown }) => {
    const payload = message.payload as { path: string; files: FileInfo[] };
    if (payload.path === currentPath) {
      setFiles(payload.files);
      setIsLoading(false);
    }
  }, [currentPath]);

  const loadDirectory = useCallback((path: string) => {
    setIsLoading(true);
    send('file.list' as any, { session_id: sessionId, path });
  }, [send, sessionId]);

  const navigate = useCallback((path: string) => {
    setCurrentPath(path);
    pathHistory.current = pathHistory.current.slice(0, historyIndex.current + 1);
    pathHistory.current.push(path);
    historyIndex.current = pathHistory.current.length - 1;
    setSelectedFiles(new Set());
  }, []);

  const goBack = useCallback(() => {
    if (historyIndex.current > 0) {
      historyIndex.current--;
      setCurrentPath(pathHistory.current[historyIndex.current]);
      setSelectedFiles(new Set());
    }
  }, []);

  const goForward = useCallback(() => {
    if (historyIndex.current < pathHistory.current.length - 1) {
      historyIndex.current++;
      setCurrentPath(pathHistory.current[historyIndex.current]);
      setSelectedFiles(new Set());
    }
  }, []);

  const goHome = useCallback(() => {
    navigate('/');
  }, [navigate]);

  const goUp = useCallback(() => {
    if (currentPath !== '/') {
      const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
      navigate(parent);
    }
  }, [currentPath, navigate]);

  const handleFileClick = useCallback((file: FileInfo, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedFiles(prev => {
        const next = new Set(prev);
        if (next.has(file.name)) next.delete(file.name);
        else next.add(file.name);
        return next;
      });
    } else if (e.shiftKey && selectedFiles.size > 0) {
      // Range selection would need file ordering
    } else {
      if (file.is_dir) {
        navigate(`${currentPath}/${file.name}`.replace(/\/+/g, '/'));
      } else {
        downloadFile(file.name);
      }
      setSelectedFiles(new Set());
    }
  }, [currentPath, navigate, selectedFiles.size]);

  const downloadFile = useCallback(async (name: string) => {
    const path = `${currentPath}/${name}`.replace(/\/+/g, '/');
    try {
      const response = await api.get(`/agents/${agentId}/files/download`, {
        params: { path },
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Downloaded ${name}`);
    } catch (err) {
      toast.error('Download failed');
    }
  }, [agentId, currentPath]);

  const handleUpload = useCallback(async (files: FileList) => {
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append('file', file);
      setUploadProgress(prev => ({ ...prev, [file.name]: 0 }));

      try {
        await api.post<FileInfo>(`/agents/${agentId}/files/upload`, formData, {
          params: { path: currentPath },
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (e) => {
            const total = e.total;
            if (total && total > 0) {
              setUploadProgress(prev => ({ ...prev, [file.name]: Math.round((e.loaded * 100) / total) }));
            }
          },
        });
        toast.success(`Uploaded ${file.name}`);
        loadDirectory(currentPath);
      } catch (err) {
        toast.error(`Failed to upload ${file.name}`);
      } finally {
        setUploadProgress(prev => {
          const next = { ...prev };
          delete next[file.name];
          return next;
        });
      }
    }
    setShowUpload(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [agentId, currentPath, loadDirectory]);

  const createDirectory = useCallback(async () => {
    const name = prompt('Enter directory name:');
    if (!name) return;
    try {
      await api.post<FileInfo>(`/agents/${agentId}/files/mkdir`, { path: `${currentPath}/${name}`.replace(/\/+/g, '/') });
      toast.success('Directory created');
      loadDirectory(currentPath);
    } catch (err) {
      toast.error('Failed to create directory');
    }
  }, [agentId, currentPath, loadDirectory]);

  const deleteFiles = useCallback(async () => {
    if (selectedFiles.size === 0) return;
    if (!confirm(`Delete ${selectedFiles.size} item(s)?`)) return;

    for (const name of selectedFiles) {
      try {
        await api.delete(`/agents/${agentId}/files`, { params: { path: `${currentPath}/${name}`.replace(/\/+/g, '/') } });
        toast.success(`Deleted ${name}`);
      } catch (err) {
        toast.error(`Failed to delete ${name}`);
      }
    }
    setSelectedFiles(new Set());
    loadDirectory(currentPath);
  }, [agentId, currentPath, selectedFiles, loadDirectory]);

  const startRename = useCallback((name: string) => {
    setRenameState({ name, newName: name });
  }, []);

  const getFileIcon = (file: FileInfo) => {
    if (file.is_dir) return <Folder className="w-8 h-8 text-yellow-500" />;
    const ext = file.name.split('.').pop()?.toLowerCase();
    const iconMap: Record<string, React.ReactNode> = {
      js: <File className="w-8 h-8 text-yellow-500" />,
      ts: <File className="w-8 h-8 text-blue-500" />,
      jsx: <File className="w-8 h-8 text-yellow-500" />,
      tsx: <File className="w-8 h-8 text-blue-500" />,
      json: <File className="w-8 h-8 text-green-500" />,
      md: <File className="w-8 h-8 text-gray-500" />,
      txt: <File className="w-8 h-8 text-gray-500" />,
      py: <File className="w-8 h-8 text-green-500" />,
      rs: <File className="w-8 h-8 text-orange-500" />,
      go: <File className="w-8 h-8 text-cyan-500" />,
      html: <File className="w-8 h-8 text-orange-500" />,
      css: <File className="w-8 h-8 text-pink-500" />,
      png: <File className="w-8 h-8 text-purple-500" />,
      jpg: <File className="w-8 h-8 text-purple-500" />,
      jpeg: <File className="w-8 h-8 text-purple-500" />,
      gif: <File className="w-8 h-8 text-purple-500" />,
      svg: <File className="w-8 h-8 text-purple-500" />,
      pdf: <File className="w-8 h-8 text-red-500" />,
      zip: <File className="w-8 h-8 text-gray-500" />,
      tar: <File className="w-8 h-8 text-gray-500" />,
      gz: <File className="w-8 h-8 text-gray-500" />,
      exe: <File className="w-8 h-8 text-blue-500" />,
      dll: <File className="w-8 h-8 text-blue-500" />,
      sh: <File className="w-8 h-8 text-green-500" />,
      bat: <File className="w-8 h-8 text-blue-500" />,
      ps1: <File className="w-8 h-8 text-blue-500" />,
    };
    return iconMap[ext || ''] || <File className="w-8 h-8 text-gray-400" />;
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div className="flex-1 flex flex-col bg-white dark:bg-dark-card">
      <div className="flex items-center gap-2 p-3 border-b border-gray-200 dark:border-dark-border bg-gray-50 dark:bg-gray-900/50">
        <div className="flex items-center gap-1">
          <button onClick={goBack} disabled={historyIndex.current === 0} className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button onClick={goForward} disabled={historyIndex.current === pathHistory.current.length - 1} className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50">
            <ChevronRight className="w-5 h-5" />
          </button>
          <button onClick={goUp} className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700">
            <ArrowUp className="w-5 h-5" />
          </button>
          <button onClick={goHome} className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700">
            <Home className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 px-3">
          <div className="relative">
            <input
              type="text"
              value={currentPath}
              className="input bg-gray-100 dark:bg-gray-800 font-mono text-sm px-8"
              readOnly
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowUpload(true)} className="btn-secondary btn-sm">
            <Upload className="w-4 h-4" />
            Upload
          </button>
          <button onClick={createDirectory} className="btn-secondary btn-sm">
            <Plus className="w-4 h-4" />
            New Folder
          </button>
          <button onClick={() => loadDirectory(currentPath)} disabled={isLoading} className="btn-secondary btn-sm">
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <div className="flex items-center gap-1 border-l border-gray-200 dark:border-dark-border pl-2 ml-2">
            <button onClick={() => setViewMode('grid')} className={`p-2 rounded ${viewMode === 'grid' ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-600' : 'text-gray-500 hover:text-gray-700'}`}>
              <Grid className="w-5 h-5" />
            </button>
            <button onClick={() => setViewMode('list')} className={`p-2 rounded ${viewMode === 'list' ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-600' : 'text-gray-500 hover:text-gray-700'}`}>
              <List className="w-5 h-5" />
            </button>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 ml-2">
            <MoreVertical className="w-5 h-5" />
          </button>
        </div>
      </div>

      {showUpload && (
        <div className="p-3 border-b border-gray-200 dark:border-dark-border bg-gray-50 dark:bg-gray-900/50">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => e.target.files && handleUpload(e.target.files)}
              className="hidden"
              id="file-upload"
            />
            <label htmlFor="file-upload" className="btn-secondary btn-sm">
              <Upload className="w-4 h-4" />
              Choose Files
            </label>
            <button onClick={() => setShowUpload(false)} className="btn-ghost btn-sm">Cancel</button>
            {Object.keys(uploadProgress).length > 0 && (
              <div className="flex-1 flex items-center gap-4 ml-4">
                {Object.entries(uploadProgress).map(([name, progress]) => (
                  <div key={name} className="flex items-center gap-2 text-sm">
                    <span className="truncate max-w-[150px]">{name}</span>
                    <div className="w-32 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-primary-600 transition-all" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="text-xs w-10 text-right">{progress}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto" role="list" aria-label="Files">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw className="w-8 h-8 animate-spin text-primary-600" />
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-dark-textMuted">
            <Folder className="w-16 h-16 mb-4 opacity-30" />
            <p className="text-lg">This folder is empty</p>
            <p className="text-sm">Upload files or create a new folder</p>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="file-grid p-4" role="list">
            {files.map((file) => (
              <FileGridItem
                key={file.name}
                file={file}
                selected={selectedFiles.has(file.name)}
                onClick={(e) => handleFileClick(file, e)}
                onRename={startRename}
                renameState={renameState?.name === file.name ? renameState : null}
                getIcon={getFileIcon}
                formatSize={formatSize}
                formatDate={formatDate}
              />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto" role="list">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-dark-border">
                  <th className="table-header w-10"><input type="checkbox" onChange={(e) => e.target.checked ? setSelectedFiles(new Set(files.map(f => f.name))) : setSelectedFiles(new Set())} /></th>
                  <th className="table-header">Name</th>
                  <th className="table-header hidden md:table-cell">Size</th>
                  <th className="table-header hidden lg:table-cell">Modified</th>
                  <th className="table-header w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-dark-border">
                {files.map((file) => (
                  <FileListItem
                    key={file.name}
                    file={file}
                    selected={selectedFiles.has(file.name)}
                    onClick={(e) => handleFileClick(file, e)}
                    onSelectChange={(selected) => {
                      setSelectedFiles(prev => {
                        const next = new Set(prev);
                        selected ? next.add(file.name) : next.delete(file.name);
                        return next;
                      });
                    }}
                    getIcon={getFileIcon}
                    formatSize={formatSize}
                    formatDate={formatDate}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedFiles.size > 0 && (
        <div className="p-3 border-t border-gray-200 dark:border-dark-border bg-gray-50 dark:bg-gray-900/50 flex items-center justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {selectedFiles.size} item(s) selected
          </span>
          <button onClick={deleteFiles} className="btn-danger btn-sm">
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

interface FileGridItemProps {
  file: FileInfo;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onRename: (name: string) => void;
  renameState: { name: string; newName: string } | null;
  getIcon: (file: FileInfo) => React.ReactNode;
  formatSize: (bytes: number) => string;
  formatDate: (dateStr: string) => string;
}

function FileGridItem({ file, selected, onClick, onRename, renameState, getIcon, formatSize, formatDate }: FileGridItemProps) {
  const isRenaming = renameState?.name === file.name;
  const [editName, setEditName] = useState(file.name);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onRename(editName);
    } else if (e.key === 'Escape') {
      setEditName(file.name);
      onRename('');
    }
  };

  return (
    <div
      className={`file-item ${selected ? 'selected' : ''}`}
      onClick={onClick}
      onDoubleClick={() => !file.is_dir && onRename(file.name)}
      role="listitem"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(e as unknown as React.MouseEvent); }}
    >
      {isRenaming ? (
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => onRename('')}
          autoFocus
          className="w-full px-2 py-1 text-sm border border-primary-500 rounded bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      ) : (
        <>
          <div className="flex items-center justify-center mb-2">{getIcon(file)}</div>
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate w-full" title={file.name}>
            {file.name}
          </p>
          <p className="text-xs text-gray-500 dark:text-dark-textMuted truncate w-full">
            {file.is_dir ? '' : formatSize(file.size)} • {formatDate(file.modified_at)}
          </p>
        </>
      )}
    </div>
  );
}

interface FileListItemProps {
  file: FileInfo;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onSelectChange: (selected: boolean) => void;
  getIcon: (file: FileInfo) => React.ReactNode;
  formatSize: (bytes: number) => string;
  formatDate: (dateStr: string) => string;
}

function FileListItem({ file, selected, onClick, onSelectChange, getIcon, formatSize, formatDate }: FileListItemProps) {
  return (
    <tr
      className={`${selected ? 'bg-primary-50 dark:bg-primary-900/20' : ''} hover:bg-gray-50 dark:hover:bg-gray-800/50`}
      onClick={onClick}
      role="listitem"
    >
      <td className="table-cell w-10">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => { e.stopPropagation(); onSelectChange(e.target.checked); }}
          className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
        />
      </td>
      <td className="table-cell">
        <div className="flex items-center gap-3">
          {getIcon(file)}
          <span className="font-mono text-sm text-gray-900 dark:text-white truncate max-w-xs" title={file.name}>
            {file.name}
          </span>
        </div>
      </td>
      <td className="table-cell hidden md:table-cell font-mono text-sm text-gray-500 dark:text-dark-textMuted">
        {file.is_dir ? '—' : formatSize(file.size)}
      </td>
      <td className="table-cell hidden lg:table-cell text-sm text-gray-500 dark:text-dark-textMuted">
        {formatDate(file.modified_at)}
      </td>
      <td className="table-cell w-10 text-right">
        <button className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300" onClick={(e) => { e.stopPropagation(); }}>
          <MoreVertical className="w-4 h-4" />
        </button>
      </td>
    </tr>
  );
}