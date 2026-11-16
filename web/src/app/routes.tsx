import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from '../components/shell/Shell.tsx';
import { useAuth } from '../lib/auth.tsx';
import { LoginPage } from '../pages/LoginPage.tsx';
import { DashboardPage } from '../pages/DashboardPage.tsx';
import { ProjectsPage } from '../pages/ProjectsPage.tsx';
import { TeamDetailPage } from '../pages/TeamDetailPage.tsx';
import { InstancesPage } from '../pages/InstancesPage.tsx';
import { PromptCardsPage } from '../pages/PromptCardsPage.tsx';
import { SettingsPage } from '../pages/SettingsPage.tsx';
import { TasksPage } from '../pages/TasksPage.tsx';
import { ProjectLayout } from '../pages/ProjectLayout.tsx';
import { ProjectOverviewPage } from '../pages/project/ProjectOverviewPage.tsx';
import { ProjectTasksPage } from '../pages/project/ProjectTasksPage.tsx';
import { ProjectTaskDetailPage } from '../pages/project/ProjectTaskDetailPage.tsx';
import { ProjectAutomationsPage } from '../pages/project/ProjectAutomationsPage.tsx';
import { ProjectMemoryPage } from '../pages/project/ProjectMemoryPage.tsx';
import { ProjectRecordsPage } from '../pages/project/ProjectRecordsPage.tsx';
import { ProjectMembersPage } from '../pages/project/ProjectMembersPage.tsx';
import { ProjectPromptCardsPage } from '../pages/project/ProjectPromptCardsPage.tsx';
import { ProjectRetrospectivePage } from '../pages/project/ProjectRetrospectivePage.tsx';
import { ProjectSettingsPage } from '../pages/project/ProjectSettingsPage.tsx';
import { ProjectServicesPage } from '../pages/project/ProjectServicesPage.tsx';
import { ProjectWecomBotPage } from '../pages/project/ProjectWecomBotPage.tsx';
import { ProjectContextPage } from '../pages/project/ProjectContextPage.tsx';
import { NotificationsPage } from '../pages/NotificationsPage.tsx';
import { AccountPage } from '../pages/AccountPage.tsx';
import { AccountsPage } from '../pages/AccountsPage.tsx';
import { ChatRecordsPage } from '../pages/ChatRecordsPage.tsx';
import { ConversationPage } from '../pages/ConversationPage.tsx';
import { WecomChatsPage } from '../pages/WecomChatsPage.tsx';
import { SystemLogsPage } from '../pages/SystemLogsPage.tsx';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { person, loading } = useAuth();
  if (loading) {
    return (
      <div className="boot-screen">
        <div className="brand-mark">R</div>
        <div className="boot-screen__text">正在加载 Ryan…</div>
      </div>
    );
  }
  if (!person) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/conversation" element={<ConversationPage />} />
        <Route path="/wecom-chats" element={<WecomChatsPage />} />
        <Route path="/system-logs" element={<SystemLogsPage />} />
        <Route path="/conversation/:conversationId" element={<ConversationPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<ProjectOverviewPage />} />
          <Route path="tasks" element={<ProjectTasksPage />} />
          <Route path="tasks/:taskId" element={<ProjectTaskDetailPage />} />
          <Route path="activity" element={<Navigate to="/system-logs" replace />} />
          <Route path="automations" element={<ProjectAutomationsPage />} />
          <Route path="memory" element={<ProjectMemoryPage />} />
          <Route path="records" element={<ProjectRecordsPage />} />
          <Route path="members" element={<ProjectMembersPage />} />
          <Route path="prompt-cards" element={<ProjectPromptCardsPage />} />
          <Route path="retrospective" element={<ProjectRetrospectivePage />} />
          <Route path="services" element={<ProjectServicesPage />} />
          <Route path="wecom-bot" element={<ProjectWecomBotPage />} />
          <Route path="context" element={<ProjectContextPage />} />
          <Route path="settings" element={<ProjectSettingsPage />} />
        </Route>
        <Route path="/teams" element={<Navigate to="/accounts?tab=teams" replace />} />
        <Route path="/teams/:teamId" element={<TeamDetailPage />} />
        <Route path="/instances" element={<InstancesPage />} />
        <Route path="/prompt-cards" element={<PromptCardsPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/chats" element={<ChatRecordsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
