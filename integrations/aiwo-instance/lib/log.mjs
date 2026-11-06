/** 日志：统一前缀与时间戳；token 永不打印。 */
export function createLogger({ verbose = false, prefix = '[aiwo-instance]' } = {}) {
  const stamp = () => new Date().toISOString().slice(11, 19);
  const log = (level, message, extra) => {
    const line = `${prefix} ${stamp()} ${level} ${message}`;
    if (extra !== undefined) console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](line, extra);
    else console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](line);
  };
  return {
    info: (message, extra) => log('INFO', message, extra),
    warn: (message, extra) => log('WARN', message, extra),
    error: (message, extra) => log('ERROR', message, extra),
    debug: (message, extra) => {
      if (verbose) log('DEBUG', message, extra);
    },
  };
}

export function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
