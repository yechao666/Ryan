import { useOutletContext } from 'react-router-dom';
import type { ProjectDetail } from '@lib/api.ts';

/** 项目工作区 Outlet 上下文：项目详情与刷新函数。 */
export interface ProjectOutletContext {
  detail: ProjectDetail;
  /** 重新拉取项目详情（成员、统计等），返回最新详情或 null。 */
  reload: () => Promise<ProjectDetail | null>;
}

/** 读取项目工作区上下文，由 ProjectLayout 注入。 */
export function useProject(): ProjectOutletContext {
  return useOutletContext<ProjectOutletContext>();
}
