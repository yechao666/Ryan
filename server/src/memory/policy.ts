/** 服务端记忆写入护栏：DSH 只能写候选，且拒绝明显是任务流水/日志/密钥的内容。 */
const LOW_VALUE = /(?:^|\n)\s*(?:任务|状态|执行结果|完成情况|命令输出|工具调用记录)\s*[:：]/i;
const LOG_LIKE = /(?:command output|stdout|stderr|git diff|tool[_ ]call|工具调用轨迹|退出码|exit code)/i;
const SECRET_LIKE = /(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S{8,}/i;

export function memoryWriteIssue(content: string, category?: string): string | null {
  const text = String(content ?? '').trim();
  if (text.length < 10) return '记忆内容太短，无法形成可复用知识';
  if (text.length > 20_000) return '记忆内容超过 20000 字符';
  if (category === 'task_result') return '任务结果不是项目记忆，请留在任务历史';
  if (SECRET_LIKE.test(text)) return '记忆不能包含密钥或敏感凭据';
  if (LOW_VALUE.test(text) && text.length < 120) return '看起来是任务流水，不是跨任务可复用的知识';
  if (LOG_LIKE.test(text) && !/(?:决策|经验|约定|结论)/.test(text)) return '日志/工具输出不是项目记忆';
  return null;
}
