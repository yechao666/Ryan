import { Callout, PageHead } from '@ui';
import { useAuth } from '@lib/auth.tsx';
import { AccountsSection } from '../components/settings/AccountsSection.tsx';

/** 账号管理：管理员维护本地账号、管理员权限和密码。 */
export function AccountsPage() {
  const { person } = useAuth();

  return (
    <div className="page">
      <PageHead
        title="账号管理"
        desc="人员即账号；管理本地账号、管理员权限与密码重置。统一认证源仍在系统设置中维护。"
      />
      {person?.isAdmin ? (
        <AccountsSection />
      ) : (
        <Callout tone="amber" icon="shield">
          账号管理仅组织管理员可访问。
        </Callout>
      )}
    </div>
  );
}
