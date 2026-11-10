import { useParams } from 'react-router-dom';
import { PromptCardsPage } from '../PromptCardsPage.tsx';

/** 项目内提示卡：复用全局提示卡管理，默认创建当前项目的项目级卡片。 */
export function ProjectPromptCardsPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return <PromptCardsPage projectId={projectId} />;
}
