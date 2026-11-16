import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Avatar, Dot, Icon, type IconName } from '@ui';
import { useAuth } from '../../lib/auth.tsx';
import { APP_NAME, APP_TAGLINE } from '@shared';
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
      { to: '/conversation', label: '对话', icon: 'sparkles' },
      { to: '/wecom-chats', label: '企业微信', icon: 'wechat' },
      { to: '/projects', label: '项目', icon: 'folder' },
      { to: '/tasks', label: '任务', icon: 'list' },
      { to: '/prompt-cards', label: '提示卡', icon: 'book' },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/instances', label: '智能体', icon: 'server' },
      { to: '/chats', label: '聊天记录', icon: 'terminal' },
      { to: '/system-logs', label: '系统日志', icon: 'activity' },
      { to: '/notifications', label: '通知', icon: 'activity' },
      { to: '/settings', label: '系统设置', icon: 'settings' },
    ],
  },
];

const ASSISTANT_STATE_EVENT = 'aiwo:assistant-state';
const ASSISTANT_TOGGLE_EVENT = 'aiwo:assistant-toggle';

export function Shell() {
  const { person, logout } = useAuth();
  const location = useLocation();
  const activeProject = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const conversationMode = location.pathname.startsWith('/conversation');
  const [assistantOpen, setAssistantOpen] = useState(() => localStorage.getItem('aiwo.assistant.open') !== '0');
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const navGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.label === '系统'
      ? [...group.items, { to: '/accounts', label: person?.isAdmin ? '账号管理' : '人员与团队', icon: 'users' as IconName }]
      : group.items,
  }));

  useEffect(() => {
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail;
      if (typeof detail?.open === 'boolean') setAssistantOpen(detail.open);
    };
    window.addEventListener(ASSISTANT_STATE_EVENT, onState);
    return () => window.removeEventListener(ASSISTANT_STATE_EVENT, onState);
  }, []);

  useEffect(() => {
    if (!accountOpen) return;
    const close = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [accountOpen]);

  const toggleAssistant = (): void => {
    window.dispatchEvent(new CustomEvent(ASSISTANT_TOGGLE_EVENT));
  };

  return (
    <div className="shell">
      <header className="shell-topbar">
        <NavLink to="/" className="topbar-brand" aria-label={`${APP_NAME} 首页`}>
          <span className="brand-mark">R</span>
          <span className="topbar-brand__text">
            <strong>{APP_NAME}</strong>
            <small>{APP_TAGLINE}</small>
          </span>
        </NavLink>

        <nav className="topnav" aria-label="主导航">
          {navGroups.map((group) => (
            <div className="topnav-group" key={group.label}>
              <span className="topnav-group__label">{group.label}</span>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `topnav-item${isActive || (item.to === '/projects' && activeProject) ? ' active' : ''}`
                  }
                >
                  <Icon name={item.icon} size={15} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="topbar-actions">
          <span className="topbar-status"><Dot tone="green" pulse />系统正常</span>
          <NavLink to="/notifications" className="topbar-icon" title="通知" aria-label="通知">
            <Icon name="activity" size={16} />
          </NavLink>
          {!conversationMode ? (
            <button
              type="button"
              className={`topbar-assistant${assistantOpen ? ' active' : ''}`}
              onClick={toggleAssistant}
              aria-pressed={assistantOpen}
              title={assistantOpen ? '收起 Ryan 助手' : '打开 Ryan 助手'}
            >
              <Icon name="sparkles" size={16} />
              <span>助手</span>
            </button>
          ) : null}
          <div className="topbar-account-wrap" ref={accountRef}>
            <button
              type="button"
              className={`topbar-account${accountOpen ? ' active' : ''}`}
              title="个人账号"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((value) => !value)}
            >
              <Avatar name={person?.name ?? '访客'} tone={(person?.avatarColor as never) ?? 'violet'} size="sm" />
              <span>{person?.name ?? '未登录'}</span>
              <Icon name="chevronDown" size={12} />
            </button>
            {accountOpen ? (
              <div className="topbar-account-menu">
                <div className="topbar-account-menu__head">
                  <strong>{person?.name ?? '未登录'}</strong>
                  <span>{person?.email ?? ''}</span>
                </div>
                <NavLink to="/account" className="topbar-account-menu__item" onClick={() => setAccountOpen(false)}>
                  <Icon name="user" size={14} />个人账号
                </NavLink>
                <button type="button" className="topbar-account-menu__item danger" onClick={() => { setAccountOpen(false); void logout(); }}>
                  <Icon name="logout" size={14} />退出登录
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="shell-body">
        <main className="main">
          <Outlet />
        </main>
        {conversationMode ? null : <Assistant />}
      </div>
    </div>
  );
}
