import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AppContext } from '../contracts.ts';
import { applyCors, handlePreflight } from './middleware/cors.ts';
import { createRequestContext } from './context.ts';
import { METHOD_MISMATCH, normalizePath, type Router } from './router.ts';
import { errors, sendError } from './respond.ts';
import { serveStatic } from './static.ts';

function requestIdOf(req: IncomingMessage): string {
  const incoming = String(req.headers['x-request-id'] ?? '').trim();
  return incoming.length > 0 && incoming.length <= 128 ? incoming : `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function createHttpServer(app: AppContext, router: Router): Server {
  return createServer(async (req, res) => {
    applyCors(req, res);
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      handlePreflight(req, res);
      return;
    }
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    const requestId = requestIdOf(req);
    const startedAt = Date.now();

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendError(res, requestId, errors.badRequest('请求 URL 不合法'));
      return;
    }
    const pathname = normalizePath(url.pathname);

    const matched = router.match(method, pathname);
    if (matched === METHOD_MISMATCH) {
      sendError(res, requestId, errors.methodNotAllowed(method, pathname));
      return;
    }

    if (matched === null) {
      if ((method === 'GET' || method === 'HEAD') && !pathname.startsWith('/api')) {
        const rc = createRequestContext({ app, req, res, url, method, pathname, params: {}, requestId });
        try {
          await serveStatic(app, rc);
        } catch (error) {
          sendError(res, requestId, error);
        }
        return;
      }
      sendError(res, requestId, errors.notFound(`未找到路由：${method} ${pathname}`));
      return;
    }

    const rc = createRequestContext({
      app,
      req,
      res,
      url,
      method,
      pathname,
      params: matched.params,
      requestId,
    });

    try {
      await matched.route.handler(rc);
    } catch (error) {
      sendError(res, requestId, error);
    } finally {
      const status = res.statusCode;
      if (pathname !== '/api/events' && status >= 400) {
        console.warn(`[http] ${requestId} ${method} ${pathname} ${status} ${Date.now() - startedAt}ms`);
      }
    }
  });
}
