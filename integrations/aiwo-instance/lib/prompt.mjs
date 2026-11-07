/**
 * 任务提示词组装。
 *
 * 约定：任务 prompt 已带 `/goal` 前缀；最终 stdin 必须以 `/goal` 开头，
 * 同时把项目提示词、引用提示卡、执行者标签一起注入（顺序：项目 → 卡片 → 任务 → 执行者）。
 */

const GOAL_PREFIX = /^\/goal(?:\s+|$)/i;

/** 去掉任务 prompt 开头的 `/goal` 标记。 */
export function stripGoalPrefix(prompt) {
  const text = String(prompt ?? '').trim();
  if (!text) return '';
  return text.replace(GOAL_PREFIX, '').trim();
}

/** 组装最终发送给 DSH 的 prompt（始终以 `/goal` 开头）。 */
export function buildPrompt(claim) {
  const task = claim?.task ?? {};
  const project = claim?.project ?? {};
  const executor = claim?.executor ?? {};
  const cards = Array.isArray(claim?.promptCards) ? claim.promptCards : [];
  const memory = claim?.memory && typeof claim.memory === 'object' ? claim.memory : {};

  const sections = ['/goal'];

  const projectLines = [];
  if (project.name) projectLines.push(project.slug ? `${project.name}（${project.slug}）` : project.name);
  if (project.prompt) projectLines.push(project.prompt);
  if (projectLines.length > 0) sections.push(`# 项目背景\n${projectLines.join('\n')}`);

  if (memory.enabled) {
    sections.push(`# 项目记忆
项目记忆不会自动注入；需要项目背景、约定或历史决策时，使用 aiwo_memory_search / aiwo_memory_context 工具按需检索。不要假设记忆中一定有答案。`);
  }

  if (cards.length > 0) {
    const cardText = cards
      .map((card) => {
        const name = card.name || card.id || '提示卡';
        const category = card.category ? `（${card.category}）` : '';
        return `## ${name}${category}\n${card.content || ''}`.trimEnd();
      })
      .join('\n\n');
    sections.push(`# 引用提示卡\n${cardText}`);
  }

  const goalText = stripGoalPrefix(task.prompt);
  const taskLines = [];
  if (task.title) taskLines.push(task.title);
  if (goalText) taskLines.push(goalText);
  if (taskLines.length > 0) sections.push(`# 任务\n${taskLines.join('\n')}`);

  if (executor.label) sections.push(`# 执行者\n${executor.label}`);

  return `${sections.join('\n\n').trimEnd()}\n`;
}
