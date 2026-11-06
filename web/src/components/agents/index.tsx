import type { Agent } from '@shared';
import { Avatar, Badge, Dot, Icon } from '@ui';
import { fmtRelative } from '../../lib/format.ts';
import { agentStatusMeta, toneFor } from '../projects/helpers.tsx';

/**
 * 智员卡片 / 列表行：智员列表、概览共用。
 * 一个智员可加入多个项目，卡片同时展示项目数、运行任务与在线实例。
 */

export function AgentStatusBadge({ status }: { status: string }) {
  const meta = agentStatusMeta(status);
  return (
    <Badge size="sm" tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

export function CapabilityChips({
  capabilities,
  max = 4,
}: {
  capabilities: string[];
  max?: number;
}) {
  if (!capabilities.length) return <span className="tiny dim">暂无能力标签</span>;
  const shown = capabilities.slice(0, max);
  const rest = capabilities.length - shown.length;
  return (
    <div className="cx-chips">
      {shown.map((capability) => (
        <span key={capability} className="chip">
          {capability}
        </span>
      ))}
      {rest > 0 ? <span className="chip dim">+{rest}</span> : null}
    </div>
  );
}

export function AgentCard({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
  const tone = toneFor(agent.id || agent.name);
  const status = agentStatusMeta(agent.status);

  return (
    <article
      className="card card-hover cx-agent-card"
      role="button"
      tabIndex={0}
      aria-label={`打开智员 ${agent.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="cx-agent-card__head">
        <Avatar name={agent.name} tone={tone} size="lg" />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row-between" style={{ gap: 8 }}>
            <div className="project-name truncate">{agent.name}</div>
            <span className="hstack gap-6">
              <Dot tone={status.tone} pulse={agent.status === 'active'} />
              <span className="tiny muted">{status.label}</span>
            </span>
          </div>
          <div className="tiny dim truncate" style={{ marginTop: 3 }}>
            {agent.role || '未设置岗位'} · 所有者 {agent.ownerName}
          </div>
        </div>
      </div>

      <p className="project-desc clamp-2" style={{ minHeight: 0 }}>
        {agent.description || '暂无智员描述'}
      </p>

      <div className="cx-agent-card__model">
        <Icon name="cpu" size={13} />
        <span className="mono truncate">{agent.model}</span>
        <span className="dim">·</span>
        <span className="tiny dim">创建于 {fmtRelative(agent.createdAt)}</span>
      </div>

      <CapabilityChips capabilities={agent.capabilities} max={4} />

      <div className="project-metrics">
        <div>
          <div className="pm-value">{agent.stats.projects}</div>
          <div className="pm-label">绑定项目</div>
        </div>
        <div>
          <div className="pm-value">{agent.stats.runningTasks}</div>
          <div className="pm-label">运行任务</div>
        </div>
        <div>
          <div className="pm-value">{agent.stats.onlineInstances}</div>
          <div className="pm-label">在线实例</div>
        </div>
      </div>

      <div className="row-between cx-project-card__foot">
        <span className="tiny dim">排队任务 {agent.stats.queuedTasks}</span>
        <span className="small muted hstack gap-4">
          查看详情
          <Icon name="arrowRight" size={13} />
        </span>
      </div>
    </article>
  );
}

/** 概览页的紧凑列表行。 */
export function AgentListRow({ agent }: { agent: Agent }) {
  const tone = toneFor(agent.id || agent.name);
  const status = agentStatusMeta(agent.status);
  return (
    <div className="cx-agent-row">
      <Avatar name={agent.name} tone={tone} size="sm" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="hstack gap-6">
          <span className="cx-agent-row__name truncate">{agent.name}</span>
          <Dot tone={status.tone} pulse={agent.status === 'active'} />
        </div>
        <div className="tiny dim truncate">{agent.role || '未设置岗位'} · {agent.model}</div>
      </div>
      <div className="cx-agent-row__stats">
        {agent.stats.projects} 项目 · {agent.stats.runningTasks} 任务
      </div>
      <Icon name="chevronRight" size={13} className="dim" />
    </div>
  );
}
