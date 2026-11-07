import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { TaskStatus, WorkItem } from '@shared';
import { TASK_BOARD_GROUPS, TASK_STATUSES } from '@shared';
import { api } from '@lib/api.ts';
import { fmtDateTime, fmtDuration, fmtRelative, fmtStartTime } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  PageHead,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  Spinner,
  Table,
  type Column,
} from '@ui';
import { CreateTaskModal } from '../../components/project/CreateTaskModal.tsx';
import { TaskCard } from '../../components/project/TaskCard.tsx';
import {
  parseTaskType,
  priorityMeta,
  TASK_TYPE_OPTIONS,
  taskSourceMeta,
  taskStatusMeta,
  taskTypeMeta,
  DURATION_FILTER_OPTIONS,
  STARTED_FILTER_OPTIONS,
  matchesDuration,
  matchesStarted,
  parseDurationFilter,
  parseStartedFilter,
  taskDurationMs,
} from '../../components/project/meta.ts';
import { useProject } from '../ProjectLayout.tsx';

type ViewMode = 'list' | 'board';
type StatusFilter = 'all' | TaskStatus;

/** 表格每页条数（客户端分页，服务端最多返回 200 条）。 */
const PAGE_SIZE = 20;

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: '全部状态' },
  ...TASK_STATUSES.map((status) => ({ value: status.value, label: status.label })),
];

/**
 * 项目任务：默认表格视图（类型 / 状态 / 关键词筛选 + 客户端分页），
 * 保留看板切换；类型与关键词写入 URL（type/q），刷新或分享后可恢复。
 */
export function ProjectTasksPage() {
  const { detail, reload } = useProject();
  const projectId = detail.project.id;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<ViewMode>('list');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState(params.get('q') ?? '');
  const refreshTimer = useRef<number | null>(null);

  const createOpen = params.get('new') === '1';
  const typeFilter = parseTaskType(params.get('type'));
  const durationFilter = parseDurationFilter(params.get('duration'));
  const startedFilter = parseStartedFilter(params.get('started'));
  const query = params.get('q') ?? '';

  // 外部 URL 变化（前进/后退、分享链接）时同步搜索输入框。
  useEffect(() => {
    setKeyword(query);
  }, [query]);

  // 筛选条件变化后回到第 1 页。
  useEffect(() => {
    setPage(1);
  }, [status, typeFilter, durationFilter, startedFilter, query, view]);

  const updateParams = (updates: Record<string, string | null>) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(updates)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const tasks = useAsync(
    () =>
      api.tasks({
        projectId,
        type: typeFilter === 'all' ? undefined : typeFilter,
        limit: 200,
      }),
    [projectId, typeFilter],
  );

  // 订阅项目事件，抖动后刷新任务列表。
  useEffect(() => {
    const off = api.subscribeEvents((event) => {
      if (event.projectId && event.projectId !== projectId) return;
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        void tasks.refresh();
      }, 700);
    }, projectId);
    return () => {
      off();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [projectId, tasks.refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (tasks.data ?? []).filter((task) => {
      if (status !== 'all' && task.status !== status) return false;
      // 旧后端可能不返回 type，按 feature 兜底。
      if (typeFilter !== 'all' && (task.type ?? 'feature') !== typeFilter) return false;
      if (!matchesDuration(task, durationFilter)) return false;
      if (!matchesStarted(task, startedFilter)) return false;
      if (!needle) return true;
      const haystack = `${task.title} ${task.id} ${task.executorLabel ?? ''} ${task.instanceName ?? ''}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [tasks.data, status, typeFilter, durationFilter, startedFilter, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );

  const hasFilters = status !== 'all' || typeFilter !== 'all' || durationFilter !== 'all' || startedFilter !== 'all' || Boolean(query.trim());
  const loading = tasks.loading && !tasks.data;

  const openTask = (task: WorkItem) => navigate(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`);

  const applySearch = () => {
    updateParams({ q: keyword.trim() || null });
    setPage(1);
  };

  const changeType = (value: string) => {
    updateParams({ type: value === 'all' ? null : value });
    setPage(1);
  };

  const changeStatus = (value: StatusFilter) => {
    setStatus(value);
    setPage(1);
  };

  const changeDuration = (value: string) => {
    updateParams({ duration: value === 'all' ? null : value });
    setPage(1);
  };

  const changeStarted = (value: string) => {
    updateParams({ started: value === 'all' ? null : value });
    setPage(1);
  };

  const changeView = (value: ViewMode) => {
    setView(value);
    setPage(1);
  };

  const clearFilters = () => {
    setStatus('all');
    setKeyword('');
    updateParams({ type: null, q: null, duration: null, started: null });
    setPage(1);
  };

  const columns: Column<WorkItem>[] = [
    {
      key: 'title',
      header: '任务',
      width: 260,
      render: (row) => (
        <div style={{ minWidth: 0 }}>
          <div className="cell-strong truncate" title={row.title}>
            {row.title}
          </div>
          <div className="tiny dim mono truncate">#{row.id.slice(0, 8)}</div>
        </div>
      ),
    },
    {
      key: 'type',
      header: '类型',
      width: 90,
      render: (row) => {
        const meta = taskTypeMeta(row.type);
        return (
          <Badge size="sm" tone={meta.tone}>
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'status',
      header: '状态',
      width: 110,
      render: (row) => {
        const meta = taskStatusMeta(row.status);
        return (
          <Badge size="sm" tone={meta.tone} dot>
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'executor',
      header: '执行人',
      width: 150,
      render: (row) => <span className="truncate">{row.executorLabel || 'Aiwo'}</span>,
    },
    {
      key: 'instance',
      header: '服务',
      width: 150,
      render: (row) => (
        <span className={row.instanceName ? 'truncate' : 'dim truncate'} title={row.instanceName || '自动分配'}>
          {row.instanceName || '自动分配'}
        </span>
      ),
    },
    {
      key: 'priority',
      header: '优先级',
      width: 90,
      render: (row) => {
        const meta = priorityMeta(row.priority);
        return (
          <Badge size="sm" tone={meta.tone}>
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'source',
      header: '来源',
      width: 110,
      render: (row) => {
        const meta = taskSourceMeta(row.source);
        return (
          <Badge size="sm" tone={meta.tone} dot>
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'started',
      header: '开始时间',
      width: 105,
      render: (row) => (
        <span className="tiny dim" title={row.startedAt ? fmtDateTime(row.startedAt) : '尚未开始'}>
          {fmtStartTime(row.startedAt)}
        </span>
      ),
      sortValue: (row) => (row.startedAt ? Date.parse(row.startedAt) : 0),
    },
    {
      key: 'duration',
      header: '运行时长',
      width: 95,
      render: (row) => (
        <span className="mono tiny" title={row.finishedAt ? '已结束' : row.startedAt ? '运行中' : '未开始'}>
          {fmtDuration(row.startedAt, row.finishedAt)}
        </span>
      ),
      sortValue: (row) => taskDurationMs(row) ?? -1,
    },
    {
      key: 'time',
      header: '更新时间',
      width: 130,
      render: (row) => (
        <span className="tiny dim" title={fmtDateTime(row.lastMessageAt ?? row.createdAt)}>
          {fmtRelative(row.lastMessageAt ?? row.startedAt ?? row.createdAt)}
        </span>
      ),
      sortValue: (row) => Date.parse(row.lastMessageAt ?? row.createdAt) || 0,
    },
  ];

  return (
    <div className="ws-page">
      <PageHead
        title="任务"
        desc="新建任务后由共享调度池中的 DSH 服务领取并交给 Aiwo 执行；支持按类型、状态与关键词筛选，点击行查看执行详情。"
      />

      <div className="toolbar">
        <div className="toolbar-left">
          <Segmented
            options={[
              { value: 'list' as ViewMode, label: '表格' },
              { value: 'board' as ViewMode, label: '看板' },
            ]}
            value={view}
            onChange={changeView}
          />
          <Select
            className="ws-filter-select"
            value={status}
            options={STATUS_FILTER_OPTIONS}
            onChange={(event) => changeStatus(event.target.value as StatusFilter)}
          />
          <Select
            className="ws-filter-select"
            value={typeFilter}
            options={TASK_TYPE_OPTIONS}
            onChange={(event) => changeType(event.target.value)}
          />
          <Select
            className="ws-filter-select"
            value={durationFilter}
            options={DURATION_FILTER_OPTIONS}
            onChange={(event) => changeDuration(event.target.value)}
          />
          <Select
            className="ws-filter-select"
            value={startedFilter}
            options={STARTED_FILTER_OPTIONS}
            onChange={(event) => changeStarted(event.target.value)}
          />
          <SearchInput
            value={keyword}
            onChange={setKeyword}
            placeholder="搜索标题 / 短 ID / 执行人 / 服务"
            className="ws-search"
            onSubmit={applySearch}
          />
          <Button size="sm" variant="ghost" icon="search" onClick={applySearch}>
            搜索
          </Button>
          <span className="tiny dim">共 {filtered.length} 个任务</span>
          {tasks.loading && tasks.data ? (
            <span className="tiny dim hstack gap-4">
              <Spinner size={12} />
              更新中
            </span>
          ) : null}
        </div>
        <div className="toolbar-right">
          {hasFilters ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              清除筛选
            </Button>
          ) : null}
          <Button variant="ghost" icon="refresh" onClick={() => void tasks.refresh()}>
            刷新
          </Button>
          <Button variant="primary" icon="plus" onClick={() => updateParams({ new: '1' })}>
            新建任务
          </Button>
        </div>
      </div>

      {tasks.error && !tasks.data ? (
        <Card>
          <div style={{ padding: 18 }}>
            <ErrorState message={tasks.error} onRetry={() => void tasks.refresh()} />
          </div>
        </Card>
      ) : view === 'list' ? (
        <Card>
          <Table
            columns={columns}
            rows={paged}
            sortable
            resizable
            rowKey={(row) => row.id}
            loading={loading}
            onRowClick={openTask}
            empty={
              hasFilters ? (
                <EmptyState
                  compact
                  icon="filter"
                  title="该筛选下暂无任务"
                  description="调整类型、状态或关键词，或清除筛选查看全部任务。"
                  action={
                    <Button size="sm" variant="outline" onClick={clearFilters}>
                      清除筛选
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon="list"
                  title="还没有任务"
                  description="创建第一个任务，由共享调度池中的 DSH 服务交给 Aiwo 执行。"
                  action={
                    <Button
                      size="sm"
                      variant="primary"
                      icon="plus"
                      onClick={() => updateParams({ new: '1' })}
                    >
                      新建任务
                    </Button>
                  }
                />
              )
            }
          />
          {!loading && filtered.length > 0 ? (
            <div className="ws-table-foot">
              <Pagination
                page={currentPage}
                totalPages={totalPages}
                total={filtered.length}
                pageSize={PAGE_SIZE}
                onChange={setPage}
              />
            </div>
          ) : null}
        </Card>
      ) : loading ? (
        <div className="ws-board-scroll">
          <div className="ws-board">
            {TASK_BOARD_GROUPS.map((group) => (
              <div className="ws-board-col" key={group.key}>
                <div className="ws-board-head">
                  <span className="ws-board-title">{group.label}</span>
                  <Skeleton w={20} h={16} />
                </div>
                <div className="ws-board-body">
                  {[0, 1].map((item) => (
                    <Skeleton key={item} h={104} style={{ borderRadius: 12 }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {hasFilters && filtered.length === 0 ? (
            <Callout tone="amber" icon="filter">
              当前筛选条件下没有任务，试试调整类型 / 状态或清除筛选。
            </Callout>
          ) : null}
          <div className="ws-board-scroll">
            <div className="ws-board">
              {TASK_BOARD_GROUPS.map((group) => {
                const items = filtered.filter((task) => group.statuses.includes(task.status));
                return (
                  <section className="ws-board-col" key={group.key}>
                    <div className="ws-board-head">
                      <span className="ws-board-title">{group.label}</span>
                      <span className="ws-board-count">{items.length}</span>
                    </div>
                    <div className="ws-board-body">
                      {items.length ? (
                        items.map((task) => <TaskCard key={task.id} task={task} onClick={openTask} />)
                      ) : (
                        <div className="ws-board-empty">
                          <Icon name="layers" size={16} />
                          <span>暂无任务</span>
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </>
      )}

      <CreateTaskModal
        open={createOpen}
        onClose={() => updateParams({ new: null })}
        onCreated={(task) => {
          updateParams({ new: null });
          void tasks.refresh();
          void reload();
          navigate(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`);
        }}
      />

    </div>
  );
}
