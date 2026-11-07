import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Avatar, Badge, Dot, Icon, type IconName } from '@ui';
import { useAuth } from '../../lib/auth.tsx';
import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@shared';
import { Assistant } from '../assistant/index.ts';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: '业务',
    items: [
      { to: '/', label: '概览', icon: 'dashboard', end: true },
      { to: '/projects', label: '项目', icon: 'folder' },
      { to: '/tasks', label: '任务', icon: 'list' },
      { to: '/teams', label: '团队', icon: 'users' },
      { to: '/prompt-cards', label: '提示卡', icon: 'book' },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/instances', label: 'DSH 服务', icon: 'server' },
      { to: '/settings', label: '系统设置', icon: 'settings' },
    ],
  },
];

export function Shell() {
  const { person, logout } = useAuth();
  const location = useLocation();
  const activeProject = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const navGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.label === '系统' && person?.isAdmin
      ? [...group.items, { to: '/accounts', label: '账号管理', icon: 'users' as IconName }]
      : group.items,
  }));

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">R</div>
          <div>
            <div className="brand-name">{APP_NAME}</div>
            <div className="brand-sub">{APP_TAGLINE}</div>
          </div>
        </div>
        <nav className="nav" aria-label="主导航">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-section">{group.label}</div>
              {group.items.map((item) => (
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
            </div>
          ))}
        </nav>
        <div className="sidebar-hint">
          <div className="sidebar-hint__title">工作方式</div>
          <p>人员 @Ryan 创建项目与任务，提示卡定义工作方式，DSH 服务负责执行；安全检查组拦截高风险输入。</p>
        </div>
        <div className="sidebar-footer">
          <div className="sidebar-account-label">账户</div>
          <div className="sidebar-person">
            <NavLink to="/account" className="sidebar-person__account" title="打开个人账号">
              <Avatar name={person?.name ?? '访客'} tone={(person?.avatarColor as never) ?? 'violet'} size="sm" />
              <div className="sidebar-person__meta">
                <div className="sidebar-person__name">{person?.name ?? '未登录'}</div>
                <div className="sidebar-person__title">{person?.title ?? ''}</div>
              </div>
            </NavLink>
            <button type="button" className="icon-btn" onClick={() => void logout()} title="退出登录">
              <Icon name="logout" size={15} />
            </button>
          </div>
          <div className="sidebar-status">
            <Dot tone="green" pulse /> 服务正常
            <Badge tone="slate">v{APP_VERSION}</Badge>
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
