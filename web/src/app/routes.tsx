import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from '../components/shell/Shell.tsx';
import { useAuth } from '../lib/auth.tsx';
import { LoginPage } from '../pages/LoginPage.tsx';
import { DashboardPage } from '../pages/DashboardPage.tsx';
import { ProjectsPage } from '../pages/ProjectsPage.tsx';
import { TeamsPage } from '../pages/TeamsPage.tsx';
import { TeamDetailPage } from '../pages/TeamDetailPage.tsx';
import { AgentsPage } from '../pages/AgentsPage.tsx';
import { AgentDetailPage } from '../pages/AgentDetailPage.tsx';
import { InstancesPage } from '../pages/InstancesPage.tsx';
import { TasksPage } from '../pages/TasksPage.tsx';
import { ProjectLayout } from '../pages/ProjectLayout.tsx';
import { ProjectOverviewPage } from '../pages/project/ProjectOverviewPage.tsx';
import { ProjectAgentsPage } from '../pages/project/ProjectAgentsPage.tsx';
import { ProjectTasksPage } from '../pages/project/ProjectTasksPage.tsx';
import { ProjectTaskDetailPage } from '../pages/project/ProjectTaskDetailPage.tsx';
import { ProjectActivityPage } from '../pages/project/ProjectActivityPage.tsx';
import { ProjectAutomationsPage } from '../pages/project/ProjectAutomationsPage.tsx';
import { ProjectMemoryPage } from '../pages/project/ProjectMemoryPage.tsx';
import { ProjectSettingsPage } from '../pages/project/ProjectSettingsPage.tsx';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { person, loading } = useAuth();
  if (loading) {
    return (
      <div className="boot-screen">
        <div className="brand-mark">H</div>
        <div className="boot-screen__text">正在加载 Hive…</div>
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
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<ProjectOverviewPage />} />
          <Route path="agents" element={<ProjectAgentsPage />} />
          <Route path="tasks" element={<ProjectTasksPage />} />
          <Route path="tasks/:taskId" element={<ProjectTaskDetailPage />} />
          <Route path="activity" element={<ProjectActivityPage />} />
          <Route path="automations" element={<ProjectAutomationsPage />} />
          <Route path="memory" element={<ProjectMemoryPage />} />
          <Route path="settings" element={<ProjectSettingsPage />} />
        </Route>
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/teams/:teamId" element={<TeamDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:agentId" element={<AgentDetailPage />} />
        <Route path="/instances" element={<InstancesPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
