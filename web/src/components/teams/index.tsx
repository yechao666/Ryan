import type { Team } from '@shared';
import { Avatar, Icon } from '@ui';
import { fmtDate, fmtRelative } from '../../lib/format.ts';
import { toneFor } from '../projects/helpers.tsx';

/**
 * 团队卡片：团队列表页与团队详情页共用。
 * 卡片展示负责人、成员数、项目数与创建时间。
 */
export function TeamCard({ team, onOpen }: { team: Team; onOpen: () => void }) {
  const tone = toneFor(team.id || team.name);
  const initial = (team.name.trim().slice(0, 1) || 'T').toUpperCase();
  const leadName = team.leadName?.trim();

  return (
    <article
      className="card card-hover cx-team-card cx-clickable"
      role="button"
      tabIndex={0}
      aria-label={`打开团队 ${team.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="cx-team-card__head">
        <div className={`project-mark tone-${tone}`} aria-hidden="true">
          {initial}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row-between" style={{ gap: 8 }}>
            <div className="project-name truncate">{team.name}</div>
            <Icon name="chevronRight" size={14} className="dim" />
          </div>
          <div className="project-slug truncate">{team.slug}</div>
        </div>
      </div>

      <p className="project-desc clamp-2">{team.description || '暂无团队描述'}</p>

      <div className="cx-team-card__stats">
        <div className="metric">
          <span className="metric-value">{team.memberCount}</span>
          <span className="metric-label">成员</span>
        </div>
        <div className="metric">
          <span className="metric-value">{team.projectCount}</span>
          <span className="metric-label">项目</span>
        </div>
        <div className="metric cx-team-card__lead">
          {leadName ? (
            <span className="hstack gap-6">
              <Avatar name={leadName} tone={toneFor(leadName)} size="sm" />
              <span className="metric-value truncate">{leadName}</span>
            </span>
          ) : (
            <span className="metric-value dim">未指派</span>
          )}
          <span className="metric-label">负责人</span>
        </div>
      </div>

      <div className="row-between cx-project-card__foot">
        <span className="tiny dim">创建于 {fmtDate(team.createdAt)}</span>
        <span className="tiny dim" title={team.createdAt}>
          {fmtRelative(team.createdAt)}
        </span>
      </div>
    </article>
  );
}
