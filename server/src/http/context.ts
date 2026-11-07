import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import type { Person } from '../../../shared/src/types.ts';
import type { AppContext } from '../contracts.ts';
import { errors, sendJson } from './respond.ts';

export interface CurrentInstance {
  id: string;
  name: string;
  status: string;
}

export function headerOf(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

export interface RequestContext {
  app: AppContext;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  params: Record<string, string>;
  requestId: string;
  person?: Person;
  instance?: CurrentInstance;
  body<S extends z.ZodTypeAny>(schema: S): Promise<z.infer<S>>;
  query<S extends z.ZodTypeAny>(schema: S): z.infer<S>;
  json(payload: unknown, status?: number, headers?: Record<string, string>): void;
}

export interface CreateContextInput {
  app: AppContext;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  params: Record<string, string>;
  requestId: string;
}

export function createRequestContext(input: CreateContextInput): RequestContext {
  const { app, req, res, url, method, pathname, params, requestId } = input;
  let bodyCache: Promise<unknown> | null = null;

  const readBody = async (): Promise<unknown> => {
    if (bodyCache) return bodyCache;
    bodyCache = new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const limit = Math.max(1024, app.env.webhookMaxBytes);
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          reject(errors.badRequest(`请求体超过上限（${limit} 字节）`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(errors.invalidJson());
        }
      });
      req.on('error', reject);
    });
    return bodyCache;
  };

  return {
    app,
    req,
    res,
    url,
    method,
    pathname,
    params,
    requestId,
    async body(schema) {
      const parsed = schema.safeParse(await readBody());
      if (!parsed.success) throw errors.validation(parsed.error.flatten());
      return parsed.data;
    },
    query(schema) {
      const raw = Object.fromEntries(url.searchParams.entries());
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw errors.validation(parsed.error.flatten());
      return parsed.data;
    },
    json(payload, status = 200, headers = {}) {
      sendJson(res, requestId, status, payload, headers);
    },
  };
}

export function personFromRow(row: {
  id: string;
  name: string;
  email: string;
  title: string | null;
  avatar_color: string;
  is_admin: number;
  password_set?: number;
  created_at: string;
  last_seen_at: string | null;
}): Person {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    title: row.title ?? '',
    avatarColor: row.avatar_color,
    isAdmin: Number(row.is_admin) === 1,
    hasPassword: row.password_set === undefined ? true : Number(row.password_set) === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? undefined,
  };
}
