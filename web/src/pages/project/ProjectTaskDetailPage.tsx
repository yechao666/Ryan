import { useNavigate, useParams } from 'react-router-dom';
import { TaskDrawer } from '../../components/project/TaskDrawer.tsx';
import { useProject } from '../ProjectLayout.tsx';

/** 任务详情页：替代原任务抽屉，作为项目工作区内的独立页面。 */
export function ProjectTaskDetailPage() {
  const { projectId = '', taskId = '' } = useParams();
  const navigate = useNavigate();
  const { reload } = useProject();

  return (
    <TaskDrawer
      inline
      taskId={taskId}
      onClose={() => navigate(`/projects/${encodeURIComponent(projectId)}/tasks`)}
      onChanged={() => void reload()}
    />
  );
}
