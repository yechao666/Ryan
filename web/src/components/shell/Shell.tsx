import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Avatar, Badge, Dot, Icon, type IconName } from '@ui';
import { useAuth } from '../../lib/auth.tsx';
import { APP_NAME, APP_TAGLINE } from '@shared';
import { Assistant } from '../assistant/index.ts';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: '概览', icon: 'dashboard', end: true },
  { to: '/projects', label: '项目', icon: 'folder' },
  { to: '/teams', label: '团队', icon: 'users' },
  { to: '/agents', label: '智员', icon: 'bot' },
  { to: '/instances', label: '实例', icon: 'server' },
  { to: '/tasks', label: '任务', icon: 'list' },
];

export function Shell() {
  const { person, logout } = useAuth();
  const location = useLocation();
  const activeProject = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">H</div>
          <div>
            <div className="brand-name">{APP_NAME}</div>
            <div className="brand-sub">{APP_TAGLINE}</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `nav-item${isActive || (item.to === '/projects' && activeProject) ? ' active' : ''}`
              }
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-hint">
          <div className="sidebar-hint__title">工作方式</div>
          <p>人员管理智员，智员加入项目后共享项目记忆；任务由人员、自动化或仓库事件触发。</p>
        </div>
        <div className="sidebar-footer">
          <div className="sidebar-person">
            <Avatar name={person?.name ?? '访客'} tone={(person?.avatarColor as never) ?? 'violet'} size="sm" />
            <div className="sidebar-person__meta">
              <div className="sidebar-person__name">{person?.name ?? '未登录'}</div>
              <div className="sidebar-person__title">{person?.title ?? ''}</div>
            </div>
            <button type="button" className="icon-btn" onClick={() => void logout()} title="退出登录">
              <Icon name="logout" size={15} />
            </button>
          </div>
          <div className="sidebar-status">
            <Dot tone="green" pulse /> 服务正常
            <Badge tone="slate">v0.1.0</Badge>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
      <Assistant />
    </div>
  );
}
