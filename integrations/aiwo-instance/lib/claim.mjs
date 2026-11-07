/**
 * claim 响应解析：只依赖 Aiwo 运行时协议字段，缺字段时给出明确错误。
 */

export function normalizeClaim(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('claim 响应不是 JSON 对象');
  }
  const task = raw.task;
  if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id) {
    throw new Error('claim 响应缺少 task.id');
  }
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) {
    throw new Error(`任务 ${task.id} 缺少 prompt`);
  }

  const project = raw.project && typeof raw.project === 'object' ? raw.project : {};
  const executor = raw.executor && typeof raw.executor === 'object' ? raw.executor : {};
  const promptCards = Array.isArray(raw.promptCards)
    ? raw.promptCards.filter((card) => card && typeof card === 'object')
    : [];

  return {
    task,
    project: {
      id: typeof project.id === 'string' ? project.id : task.projectId ?? '',
      name: typeof project.name === 'string' ? project.name : '',
      slug: typeof project.slug === 'string' ? project.slug : '',
      prompt: typeof project.prompt === 'string' ? project.prompt : '',
      repoUrl: typeof project.repoUrl === 'string' ? project.repoUrl : undefined,
      workspacePath: typeof project.workspacePath === 'string' ? project.workspacePath : undefined,
      type: typeof project.type === 'string' ? project.type : undefined,
      memoryAgentId: typeof project.memoryAgentId === 'string' ? project.memoryAgentId : undefined,
    },
    executor: {
      personId: typeof executor.personId === 'string' ? executor.personId : undefined,
      name: typeof executor.name === 'string' ? executor.name : '',
      label: typeof executor.label === 'string' ? executor.label : '',
    },
    promptCards: promptCards.map((card) => ({
      id: typeof card.id === 'string' ? card.id : '',
      name: typeof card.name === 'string' ? card.name : '',
      category: typeof card.category === 'string' ? card.category : '',
      content: typeof card.content === 'string' ? card.content : '',
    })),
    memory: raw.memory && typeof raw.memory === 'object' ? raw.memory : undefined,
  };
}
