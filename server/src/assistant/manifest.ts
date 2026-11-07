/** 助手使用的稳定 API 清单；不从源码解析，随开放 API 一起维护。 */
export function assistantApiManifest() {
  return {
    name: 'Aiwo API',
    version: 1,
    auth: 'Authorization: Bearer <当前人员会话 token>',
    basePath: '/api',
    notes: [
      '所有人员态接口使用当前登录人员 token；服务运行时接口使用服务 token。',
      '任务执行者固定为人员@Aiwo；DSH 服务是共享调度资源。',
      '项目工作区由 DSH 服务按项目 ID 自动生成，API 不接收工作目录。',
    ],
    endpoints: [
      { method: 'GET', path: '/api/auth/me', summary: '当前人员' },
      { method: 'GET', path: '/api/persons', summary: '人员列表' },
      { method: 'GET', path: '/api/teams', summary: '团队列表' },
      { method: 'GET', path: '/api/projects', summary: '可见项目列表' },
      {
        method: 'POST', path: '/api/projects',
        summary: '创建项目',
        body: { name: 'string', slug: 'string?', description: 'string?', ownerTeamId: 'string?', visibility: 'private|team|public?', type: 'manual|github|gitlab|local?', prompt: 'string?', repoUrl: 'string?' },
      },
      { method: 'GET', path: '/api/projects/:id', summary: '项目详情与成员' },
      { method: 'PATCH', path: '/api/projects/:id', summary: '更新项目' },
      { method: 'GET', path: '/api/projects/:id/prompt-cards', summary: '项目可引用提示词卡片' },
      { method: 'GET', path: '/api/prompt-cards', summary: '提示词卡片列表' },
      {
        method: 'POST', path: '/api/prompt-cards',
        summary: '创建提示词卡片',
        body: { name: 'string', category: 'workflow|style|standard|role|other?', description: 'string?', content: 'string', scope: 'org|team|project?', projectId: 'string?', teamId: 'string?' },
      },
      { method: 'GET', path: '/api/instances', summary: 'DSH 服务列表（共享调度资源，不绑定项目）' },
      {
        method: 'POST', path: '/api/instances',
        summary: '创建 DSH 服务并返回一次性 token 与服务代理安装命令',
        body: { name: 'string', kind: 'local|remote?', host: 'string?', port: 'number?', baseUrl: 'string?' },
      },
      { method: 'POST', path: '/api/instances/:id/test', summary: '测试服务心跳' },
      { method: 'POST', path: '/api/instances/:id/start', summary: '启动本机服务代理' },
      { method: 'POST', path: '/api/instances/:id/token', summary: '轮换服务 token' },
      { method: 'GET', path: '/api/tasks', summary: '任务列表', query: { projectId: 'string?', status: 'string?', type: 'string?', mine: '0|1?', limit: 'number?' } },
      {
        method: 'POST', path: '/api/projects/:id/tasks',
        summary: '创建任务；执行者由服务端固定为创建人@Aiwo',
        body: { title: 'string', prompt: 'string', promptCardIds: 'string[]?', instanceId: 'string?', type: 'feature|bugfix|management|ops|docs|other?', priority: 'number?', source: 'human|automation|webhook|api?' },
      },
      { method: 'GET', path: '/api/tasks/:id', summary: '任务详情、事件与记忆配置' },
      { method: 'POST', path: '/api/tasks/:id/cancel', summary: '取消任务' },
      { method: 'GET', path: '/api/projects/:id/automations', summary: '自动化列表' },
      {
        method: 'POST', path: '/api/projects/:id/automations',
        summary: '创建自动化',
        body: { name: 'string', triggerType: 'manual|webhook|cron', triggerConfig: 'object?', promptTemplate: 'string', promptCardIds: 'string[]?', instanceId: 'string?', enabled: 'boolean?' },
      },
      { method: 'POST', path: '/api/automations/:id/run', summary: '手动运行自动化' },
      { method: 'GET', path: '/api/projects/:id/memory/search', summary: '搜索项目记忆', query: { q: 'string', topK: 'number?' } },
      { method: 'GET', path: '/api/projects/:id/memory/context', summary: '项目记忆上下文', query: { q: 'string?' } },
      { method: 'GET', path: '/api/settings', summary: '系统设置（安全检查/助手）' },
      { method: 'PATCH', path: '/api/settings/security', summary: '更新安全检查配置' },
      { method: 'PATCH', path: '/api/settings/assistant', summary: '更新助手配置' },
      { method: 'GET', path: '/api/assistant/manifest', summary: '本 API 清单' },
    ],
  };
}
