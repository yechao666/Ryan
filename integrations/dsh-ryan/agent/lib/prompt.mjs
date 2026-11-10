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
    const brief = typeof memory.brief === 'string' ? memory.brief.trim() : '';
    if (brief) {
      sections.push(`# 项目记忆简报
${brief}

（简报只包含最近的记忆/洞见，最多 ${Number(memory.maxChars) || 500} 字；需要更多背景时使用 aiwo_memory_search / aiwo_memory_context 工具。）`);
    }
    sections.push(`# 项目记忆
项目记忆详细信息不会全部注入，需要项目背景、约定或历史决策时，使用 aiwo_memory_search / aiwo_memory_context 工具按需检索。不要假设记忆中一定有答案。

写入准则：只写跨任务可复用、长期有效的知识，例如决策及原因、项目约定、领域事实、架构/接口关系、踩坑经验、可复用流程。不要写普通任务摘要、完成状态、逐文件改动、命令输出、临时调试信息、未验证猜测或密钥/隐私。任务结果请留在任务历史。
如果任务确实产生了长期有效的决策或经验，请在最终输出末尾使用「## 决策」和「## 经验」小节；如果有关键阶段进展，请使用「## 关键进展」小节。若发现风险/阻塞、基线变更、验收结论、未决假设或外部依赖，也分别使用「## 风险与阻塞」「## 变更」「## 验收与质量」「## 假设与待确认」「## 依赖与承诺」小节。没有实质内容时不要为了凑格式而写。这些记录会进入项目的复盘总结流程。`);
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
