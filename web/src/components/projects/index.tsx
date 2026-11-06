import type { ProjectSummary, ProjectType, Visibility } from '@shared';
import { PROJECT_TYPES, VISIBILITIES } from '@shared';
import { Badge, Icon, type Tone } from '@ui';
import { fmtRelative } from '../../lib/format.ts';
import { toneFor } from './helpers.tsx';

/**
 * 项目卡片与徽章：项目页、概览、团队详情共用。
 * 点击整卡进入项目工作区，支持键盘操作。
 */

export function projectTypeMeta(type: ProjectType) {
  return PROJECT_TYPES.find((item) => item.value === type) ?? { value: type, label: type, tone: 'slate' as Tone };
}

export function visibilityMeta(visibility: Visibility) {
  return (
    VISIBILITIES.find((item) => item.value === visibility) ?? {
      value: visibility,
      label: visibility,
      desc: '',
      tone: 'slate',
    }
  );
}

export function ProjectBadges({ project, showTeam }: { project: ProjectSummary; showTeam?: boolean }) {
  const type = projectTypeMeta(project.type);
  const visibility = visibilityMeta(project.visibility);
  return (
    <div className="badge-dot-list">
      <Badge size="sm" tone={type.tone as Tone}>
        {type.label}
      </Badge>
      <Badge size="sm" tone={visibility.tone as Tone} dot>
        {visibility.label}
      </Badge>
      {showTeam ? (
        <span className="tiny dim truncate">{project.ownerTeamName ?? '个人项目'}</span>
      ) : null}
    </div>
  );
}

export function ProjectCard({
  project,
  onOpen,
  showTeam = true,
}: {
  project: ProjectSummary;
  onOpen: () => void;
  showTeam?: boolean;
}) {
  const tone = toneFor(project.id || project.slug || project.name);
  const counts = project.counts;
  const initial = (project.name.trim().slice(0, 1) || 'H').toUpperCase();

  return (
    <article
      className="card card-hover project-card cx-project-card"
      role="button"
      tabIndex={0}
      aria-label={`打开项目 ${project.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="project-card-top">
        <div className={`project-mark tone-${tone}`} aria-hidden="true">
          {initial}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row-between" style={{ gap: 8 }}>
            <div className="project-name truncate">{project.name}</div>
            <Icon name="chevronRight" size={14} className="dim" />
          </div>
          <div className="project-slug truncate">{project.slug}</div>
        </div>
      </div>

      <p className="project-desc clamp-2">{project.description || '暂无项目描述'}</p>

      <ProjectBadges project={project} showTeam={showTeam} />

      <div className="project-metrics">
        <div>
          <div className="pm-value">{counts.promptCards}</div>
          <div className="pm-label">提示词</div>
        </div>
        <div>
          <div className="pm-value">{counts.activeTasks}</div>
          <div className="pm-label">进行任务</div>
        </div>
        <div>
          <div className="pm-value">{counts.instances}</div>
          <div className="pm-label">在线实例</div>
        </div>
      </div>

      <div className="row-between cx-project-card__foot">
        <span className="tiny dim">
          成员 {counts.members} · 任务 {counts.tasks}
        </span>
        <span className="tiny dim" title={project.lastActivityAt ?? undefined}>
          最近活动 {fmtRelative(project.lastActivityAt)}
        </span>
      </div>
    </article>
  );
}
