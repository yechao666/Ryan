import { useEffect, useMemo, useState } from 'react';
import type { DshInstance } from '@shared';
import { api, type ProjectWorkspaceFile, type ProjectWorkspaceResponse } from '@lib/api.ts';
import { Badge, Callout, EmptyState, Icon, Modal, SearchInput, Skeleton } from '@ui';
import { fmtDateTime } from '@lib/format.ts';

function fmtBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (next: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  return (
    <div className="ws-breadcrumbs">
      <button type="button" onClick={() => onNavigate('')}>工作区</button>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="hstack gap-4">
          <span className="dim">/</span>
          <button type="button" onClick={() => onNavigate(parts.slice(0, index + 1).join('/'))}>{part}</button>
        </span>
      ))}
    </div>
  );
}

export function ProjectWorkspaceBrowser({
  open,
  projectId,
  service,
  onClose,
}: {
  open: boolean;
  projectId: string;
  service: DshInstance | null;
  onClose: () => void;
}) {
  const [path, setPath] = useState('');
  const [data, setData] = useState<ProjectWorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [file, setFile] = useState<ProjectWorkspaceFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !service) return;
    setPath('');
    setFile(null);
    setSearch('');
  }, [open, service]);

  useEffect(() => {
    if (!open || !service) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFileError(null);
    void api.projectWorkspace(projectId, service.id, path)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '读取工作区失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, service, path]);

  const entries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.entries ?? []).filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
  }, [data, search]);

  const openFile = async (filePath: string) => {
    if (!service) return;
    setFileLoading(true);
    setFileError(null);
    try {
      setFile(await api.projectWorkspaceFile(projectId, service.id, filePath));
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : '读取文件失败');
    } finally { setFileLoading(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={service ? `${service.name} · 工作区` : '项目工作区'}
      description="当前项目在该智能体上的工作目录与产物。只读浏览，不修改文件。"
      size="lg"
      footer={<button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>}
    >
      {data ? (
        <div className="ws-workspace-meta">
          <Badge size="sm" tone={data.available ? 'green' : 'amber'} dot>{data.available ? '可浏览' : '远端智能体'}</Badge>
          <code className="ws-workspace-path" title={data.workspaceRoot}>{data.workspaceRoot || '未注册工作区根目录'}</code>
        </div>
      ) : null}
      {error ? <Callout tone="red" icon="alert">{error}</Callout> : null}
      {data && !data.available ? (
        <Callout tone="amber" icon="info">{data.reason ?? '该智能体暂不支持在线浏览工作区。'}</Callout>
      ) : null}
      {data?.available ? (
        <div className="ws-workspace-layout">
          <div className="ws-workspace-list">
            <Breadcrumbs path={path} onNavigate={(next) => { setPath(next); setFile(null); }} />
            <SearchInput value={search} onChange={setSearch} placeholder="搜索当前目录" />
            {loading ? (
              <div className="vstack gap-6">{[0, 1, 2, 3].map((item) => <Skeleton key={item} h={34} />)}</div>
            ) : entries.length === 0 ? (
              <EmptyState icon="folder" title={data.exists ? '目录为空' : '工作区还没有产物'} description={data.exists ? '当前目录没有文件。' : '任务执行后会在这里生成文件。'} compact />
            ) : (
              <div className="ws-workspace-entries">
                {entries.map((entry) => (
                  <button
                    type="button"
                    key={entry.path}
                    className={`ws-workspace-entry${entry.type === 'dir' ? ' is-dir' : ''}`}
                    onClick={() => { if (entry.type === 'dir') { setPath(entry.path); setFile(null); } else { void openFile(entry.path); } }}
                  >
                    <Icon name={entry.type === 'dir' ? 'folder' : 'book'} size={13} />
                    <span className="truncate">{entry.name}</span>
                    <span className="tiny dim">{entry.type === 'dir' ? '目录' : fmtBytes(entry.size)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="ws-workspace-preview">
            {!file && !fileLoading && !fileError ? (
              <EmptyState icon="eye" title="选择文件预览" description="文本、代码和图片可以直接查看；二进制文件只显示大小。" compact />
            ) : fileLoading ? (
              <div className="vstack gap-6">{[0, 1, 2, 3].map((item) => <Skeleton key={item} h={14} />)}</div>
            ) : fileError ? (
              <Callout tone="red" icon="alert">{fileError}</Callout>
            ) : file ? (
              <>
                <div className="ws-workspace-preview-head">
                  <div className="vstack gap-2" style={{ minWidth: 0 }}>
                    <span className="strong truncate">{file.name}</span>
                    <span className="tiny dim">{fmtBytes(file.size)} · {fmtDateTime(file.mtime)}{file.truncated ? ' · 已截断' : ''}</span>
                  </div>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFile(null)}>关闭</button>
                </div>
                {file.dataUrl ? <img className="ws-workspace-image" src={file.dataUrl} alt={file.name} /> : file.binary ? (
                  <EmptyState icon="book" title="二进制文件" description="当前仅支持预览文本、代码和图片。" compact />
                ) : (
                  <pre className="ws-workspace-text">{file.content}</pre>
                )}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
