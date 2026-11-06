import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { TaskStatus, WorkItem } from '@shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  IconButton,
  PageHead,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  Stat,
  Table,
  type Column,
} from '@ui';
import { api } from '../lib/api.ts';
import { fmtDateTime, fmtDuration, fmtInt, fmtRelative, fmtStartTime } from '../lib/format.ts';
import { errorText, useResource } from '../components/projects/helpers.tsx';
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
} from '../components/project/meta.ts';

/** 全局任务视图：状态 / 类型 / 关键词筛选 + 我创建的 + 汇总 + 客户端分页。 */
type StatusFilter = 'all' | TaskStatus;

/** 表格每页条数。 */
const PAGE_SIZE = 20;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'queued', label: '排队' },
  { value: 'running', label: '执行中' },
  { value: 'waiting_input', label: '等待输入' },
  { value: 'done', label: '完成' },
  { value: 'failed', label: '失败' },
];

function parseStatus(value: string | null): StatusFilter {
  return STATUS_FILTERS.some((item) => item.value === value) ? (value as StatusFilter) : 'all';
}

export function TasksPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const statusFilter = parseStatus(params.get('status'));
  const typeFilter = parseTaskType(params.get('type'));
  const durationFilter = parseDurationFilter(params.get('duration'));
  const startedFilter = parseStartedFilter(params.get('started'));
  const query = params.get('q') ?? '';
  const [mine, setMine] = useState(false);
  const [keyword, setKeyword] = useState(query);
  const [page, setPage] = useState(1);

  // 前进/后退或分享链接恢复搜索词。
  useEffect(() => {
    setKeyword(query);
  }, [query]);

  // 筛选变化重置到第 1 页。
  useEffect(() => {
    setPage(1);
  }, [statusFilter, typeFilter, durationFilter, startedFilter, query, mine]);

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

  const { data: tasks, loading, error, status, reload } = useResource<WorkItem[]>(
    () =>
      api.tasks({
        status: statusFilter === 'all' ? undefined : statusFilter,
        type: typeFilter === 'all' ? undefined : typeFilter,
        mine,
        limit: 200,
      }),
    [statusFilter, typeFilter, mine],
  );

  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (tasks ?? []).filter((task) => {
      // 服务端已按类型过滤；这里再兜底一次，兼容旧后端且切换筛选时即时生效。
      if (typeFilter !== 'all' && (task.type ?? 'feature') !== typeFilter) return false;
      if (!matchesDuration(task, durationFilter)) return false;
      if (!matchesStarted(task, startedFilter)) return false;
      if (!needle) return true;
      const haystack = `${task.title} ${task.id} ${task.executorLabel ?? ''} ${task.instanceName ?? ''}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [tasks, query, typeFilter, durationFilter, startedFilter]);

  const stats = useMemo(() => {
    return {
      total: list.length,
      running: list.filter((task) => task.status === 'running').length,
      waiting: list.filter((task) => task.status === 'waiting_input').length,
      failed: list.filter((task) => task.status === 'failed').length,
    };
  }, [list]);

  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => list.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [list, currentPage],
  );

  const setStatusFilter = (next: StatusFilter) => {
    updateParams({ status: next === 'all' ? null : next });
    setPage(1);
  };

  const setTypeFilter = (value: string) => {
    updateParams({ type: value === 'all' ? null : value });
    setPage(1);
  };

  const applySearch = () => {
    updateParams({ q: keyword.trim() || null });
    setPage(1);
  };

  const setDurationFilter = (value: string) => {
    updateParams({ duration: value === 'all' ? null : value });
    setPage(1);
  };

  const setStartedFilter = (value: string) => {
    updateParams({ started: value === 'all' ? null : value });
    setPage(1);
  };

  const hasFilter =
    statusFilter !== 'all' ||
    typeFilter !== 'all' ||
    durationFilter !== 'all' ||
    startedFilter !== 'all' ||
    Boolean(query.trim()) ||
    mine;
  const clearFilters = () => {
    setParams({}, { replace: true });
    setKeyword('');
    setMine(false);
    setPage(1);
  };

  const columns: Column<WorkItem>[] = [
    {
      key: 'title',
      header: '任务',
      width: 260,
      render: (task) => (
        <div style={{ minWidth: 0 }}>
          <div className="cell-strong truncate" title={task.title}>
            {task.title}
          </div>
          <div className="tiny dim mono truncate">#{task.id.slice(0, 8)}</div>
        </div>
      ),
    },
    {
      key: 'type',
      header: '类型',
      width: 90,
      render: (task) => {
        const meta = taskTypeMeta(task.type);
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
      render: (task) => {
        const meta = taskStatusMeta(task.status);
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
      render: (task) => <span className="truncate">{task.executorLabel || 'Aiwo'}</span>,
    },
    {
      key: 'instance',
      header: '实例',
      width: 150,
      render: (task) => (
        <span className={task.instanceName ? 'truncate' : 'dim truncate'} title={task.instanceName || '自动分配'}>
          {task.instanceName || '自动分配'}
        </span>
      ),
    },
    {
      key: 'priority',
      header: '优先级',
      width: 90,
      render: (task) => {
        const meta = priorityMeta(task.priority);
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
      render: (task) => {
        const meta = taskSourceMeta(task.source);
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
      render: (task) => (
        <span className="tiny dim" title={task.startedAt ? fmtDateTime(task.startedAt) : '尚未开始'}>
          {fmtStartTime(task.startedAt)}
        </span>
      ),
      sortValue: (task) => (task.startedAt ? Date.parse(task.startedAt) : 0),
    },
    {
      key: 'duration',
      header: '运行时长',
      width: 95,
      render: (task) => (
        <span className="mono tiny" title={task.finishedAt ? '已结束' : task.startedAt ? '运行中' : '未开始'}>
          {fmtDuration(task.startedAt, task.finishedAt)}
        </span>
      ),
      sortValue: (task) => taskDurationMs(task) ?? -1,
    },
    {
      key: 'time',
      header: '更新时间',
      width: 130,
      render: (task) => (
        <span className="tiny dim" title={fmtDateTime(task.lastMessageAt ?? task.createdAt)}>
          {fmtRelative(task.lastMessageAt ?? task.startedAt ?? task.createdAt)}
        </span>
      ),
      sortValue: (task) => Date.parse(task.lastMessageAt ?? task.createdAt) || 0,
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="任务 · Tasks"
        title="任务"
        desc="全局任务视图：任务由人员、自动化或仓库事件触发，由实例领取执行。"
        actions={
          <>
            <IconButton icon="refresh" label="刷新任务" onClick={() => void reload()} />
            <Link to="/projects" className="btn btn-primary btn-sm">
              前往项目
            </Link>
          </>
        }
      />

      {loading && !tasks ? (
        <div className="kpi-grid">
          {[0, 1, 2, 3].map((item) => (
            <div className="kpi" key={item}>
              <Skeleton w="42%" h={11} />
              <div style={{ height: 14 }} />
              <Skeleton w="55%" h={24} />
              <div style={{ height: 10 }} />
              <Skeleton w="70%" h={10} />
            </div>
          ))}
        </div>
      ) : (
        <div className="kpi-grid">
          <Stat
            label="任务总数"
            value={fmtInt(stats.total)}
            icon="list"
            tone="violet"
            hint={hasFilter ? '当前筛选结果' : '全部可见任务'}
          />
          <Stat
            label="执行中"
            value={fmtInt(stats.running)}
            icon="zap"
            tone="amber"
            hint={hasFilter ? '当前筛选结果' : '实例正在处理'}
          />
          <Stat
            label="等待输入"
            value={fmtInt(stats.waiting)}
            icon="info"
            tone="blue"
            hint={hasFilter ? '当前筛选结果' : '需要人工回复'}
          />
          <Stat
            label="失败"
            value={fmtInt(stats.failed)}
            icon="xCircle"
            tone="red"
            hint={hasFilter ? '当前筛选结果' : '需要排查原因'}
          />
        </div>
      )}

      <div className="cx-filter-bar">
        <div className="cx-filter-left">
          <Segmented<StatusFilter> value={statusFilter} onChange={setStatusFilter} options={STATUS_FILTERS} />
          <Select
            className="ws-filter-select"
            value={typeFilter}
            options={TASK_TYPE_OPTIONS}
            onChange={(event) => setTypeFilter(event.target.value)}
          />
          <Select
            className="ws-filter-select"
            value={durationFilter}
            options={DURATION_FILTER_OPTIONS}
            onChange={(event) => setDurationFilter(event.target.value)}
          />
          <Select
            className="ws-filter-select"
            value={startedFilter}
            options={STARTED_FILTER_OPTIONS}
            onChange={(event) => setStartedFilter(event.target.value)}
          />
          <Checkbox checked={mine} onChange={setMine} label="只看我的" />
          <SearchInput
            value={keyword}
            onChange={setKeyword}
            placeholder="搜索标题 / 短 ID / 执行人 / 实例"
            className="ws-search"
            onSubmit={applySearch}
          />
          <Button size="sm" variant="ghost" icon="search" onClick={applySearch}>
            搜索
          </Button>
        </div>
        <div className="hstack gap-8">
          {hasFilter ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              清除筛选
            </Button>
          ) : null}
          <span className="tiny dim">共 {list.length} 个任务</span>
        </div>
      </div>

      {error && !tasks ? (
        <ErrorState message={errorText(status, error, '任务')} onRetry={() => void reload()} />
      ) : (
        <Card>
          <Table
            columns={columns}
            rows={paged}
            sortable
            resizable
            rowKey={(task) => task.id}
            loading={loading && !tasks}
            onRowClick={(task) => navigate(`/projects/${task.projectId}/tasks/${task.id}`)}
            empty={
              hasFilter ? (
                <EmptyState
                  compact
                  icon="filter"
                  title="该筛选下暂无任务"
                  description="换一个类型 / 状态 / 关键词，或清除筛选查看全部任务。"
                  action={
                    <Button size="sm" onClick={clearFilters}>
                      清除筛选
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon="list"
                  title="还没有任务"
                  description="在项目工作区创建任务，或等待自动化与仓库事件触发。"
                  action={
                    <Link to="/projects" className="btn btn-secondary btn-sm">
                      前往项目
                    </Link>
                  }
                />
              )
            }
          />
          {!loading && list.length > 0 ? (
            <div className="ws-table-foot">
              <Pagination
                page={currentPage}
                totalPages={totalPages}
                total={list.length}
                pageSize={PAGE_SIZE}
                onChange={setPage}
              />
            </div>
          ) : null}
        </Card>
      )}

      <div className="row-between">
        <span className="tiny dim">
          状态说明：排队 → 执行中 → 完成 / 失败；等待输入表示需要人工回复。
        </span>
        <span className="tiny dim">点击任务行打开项目工作区的任务详情</span>
      </div>
    </div>
  );
}
