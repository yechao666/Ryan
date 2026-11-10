import { useSearchParams } from 'react-router-dom';
import { Callout, PageHead, Tabs } from '@ui';
import { useAuth } from '@lib/auth.tsx';
import { AccountsSection } from '../components/settings/AccountsSection.tsx';
import { TeamsPage } from './TeamsPage.tsx';

type AccountTab = 'accounts' | 'teams';

/** 账号管理：平台人员与团队，管理员维护账号与权限。 */
export function AccountsPage() {
  const { person } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: AccountTab = requested === 'teams' ? 'teams' : requested === 'accounts' ? 'accounts' : person?.isAdmin ? 'accounts' : 'teams';

  const changeTab = (next: string): void => {
    setParams(next === 'teams' ? { tab: 'teams' } : {}, { replace: true });
  };

  return (
    <div className="page">
      <PageHead
        title="账号管理"
        desc="每位员工对应一个平台账号，通常绑定企业微信；账号管理负责员工身份、管理员权限、密码与团队归属。"
      />
      <Tabs
        tabs={[
          { key: 'accounts', label: '员工账号' },
          { key: 'teams', label: '团队' },
        ]}
        value={tab}
        onChange={changeTab}
      />
      <div className="mt-12">
        {tab === 'accounts' ? (
          person?.isAdmin ? (
            <AccountsSection />
          ) : (
            <Callout tone="amber" icon="shield">
              人员账号仅组织管理员可管理；团队可以在「团队」页签查看。
            </Callout>
          )
        ) : (
          <TeamsPage embedded />
        )}
      </div>
    </div>
  );
}
