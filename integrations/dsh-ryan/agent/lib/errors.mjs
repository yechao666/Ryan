/** 自定义错误类型：用于 ACP 回退、任务中断与超时判断。 */

export class AcpUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'AcpUnavailableError';
    this.cause = cause;
  }
}

export class TaskAbortError extends Error {
  constructor(message = '任务被中断') {
    super(message);
    this.name = 'TaskAbortError';
  }
}

export class TaskTimeoutError extends TaskAbortError {
  constructor(message = '任务执行超时') {
    super(message);
    this.name = 'TaskTimeoutError';
  }
}
