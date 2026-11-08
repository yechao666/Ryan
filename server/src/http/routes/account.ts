/** 账号体系：人员即账号，支持本地密码 + 多个 OIDC 统一认证。 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Router } from '../router.ts';
import { requireAdmin, requirePerson, createSession } from '../auth.ts';
import { errors } from '../respond.ts';
import { hashPassword, verifyPassword } from '../../lib/password.ts';
import { newId, nowIso, randomToken, sha256 } from '../../lib/ids.ts';
import { personFromRow } from '../context.ts';

interface ProviderRow {
  id: string;
  slug: string;
  name: string;
  type: string;
  issuer: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  enabled: number;
  auto_create: number;
  created_at: string;
  updated_at: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

const discoveryCache = new Map<string, { at: number; value: Discovery }>();
const STATE_TTL_MS = 10 * 60_000;

function rowOf<T>(db: any, sql: string, params: (string | number | null)[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
function rowsOf<T>(db: any, sql: string, params: (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function baseUrl(rc: any): string {
  if (process.env.AIWO_PUBLIC_URL) return process.env.AIWO_PUBLIC_URL.replace(/\/+$/, '');
  const proto = String(rc.req.headers['x-forwarded-proto'] || 'http').split(',')[0]!.trim();
  const host = String(rc.req.headers['x-forwarded-host'] || rc.req.headers.host || `${rc.app.env.host}:${rc.app.env.port}`).split(',')[0]!.trim();
  return `${proto}://${host}`;
}

function providerRow(db: any, by: { id?: string; slug?: string }): ProviderRow | undefined {
  if (by.id) return rowOf<ProviderRow>(db, 'SELECT * FROM auth_providers WHERE id = ?', [by.id]);
  return rowOf<ProviderRow>(db, 'SELECT * FROM auth_providers WHERE slug = ?', [by.slug ?? '']);
}

function publicProvider(row: ProviderRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: 'oidc' as const,
    issuer: row.issuer,
    enabled: Boolean(row.enabled),
    autoCreate: Boolean(row.auto_create),
    clientId: row.client_id,
    clientSecretConfigured: Boolean(row.client_secret),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function discover(row: ProviderRow): Promise<Discovery> {
  const cached = discoveryCache.get(row.id);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
  const issuer = row.issuer.replace(/\/+$/, '');
  const url = issuer.endsWith('.well-known/openid-configuration')
    ? issuer
    : `${issuer}/.well-known/openid-configuration`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OIDC discovery 返回 ${response.status}`);
  const data = await response.json() as Partial<Discovery>;
  if (!data.authorization_endpoint || !data.token_endpoint || !data.userinfo_endpoint) {
    throw new Error('OIDC discovery 缺少 endpoint');
  }
  const value = {
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
    userinfo_endpoint: data.userinfo_endpoint,
  };
  discoveryCache.set(row.id, { at: Date.now(), value });
  return value;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function safeReturnTo(value: unknown): string {
  const text = typeof value === 'string' ? value : '/';
  return text.startsWith('/') && !text.startsWith('//') ? text : '/';
}

function redirect(rc: any, location: string): void {
  rc.res.statusCode = 302;
  rc.res.setHeader('location', location);
  rc.res.end();
}

export function registerAccountRoutes(router: Router): void {
  // 登录页公开的认证源列表
  router.get('/api/auth/providers', (rc) => {
    const rows = rowsOf<ProviderRow>(rc.app.db, 'SELECT * FROM auth_providers WHERE enabled = 1 ORDER BY name ASC');
    rc.json(rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, type: 'oidc' })));
  });

  // 登录发起：浏览器跳转到 OIDC
  router.get('/api/auth/sso/:slug/start', async (rc) => {
    const provider = providerRow(rc.app.db, { slug: rc.params.slug });
    if (!provider || !provider.enabled) {
      redirect(rc, `/login?sso_error=${encodeURIComponent('统一认证未启用')}`);
      return;
    }
    try {
      const disco = await discover(provider);
      const { verifier, challenge } = pkce();
      const state = randomToken(24);
      const redirectUri = `${baseUrl(rc)}/api/auth/sso/${encodeURIComponent(provider.slug)}/callback`;
      const returnTo = safeReturnTo(rc.query(z.object({ returnTo: z.string().optional() })).returnTo);
      const now = Date.now();
      rc.app.db.prepare(
        `INSERT INTO auth_states (state, provider_id, verifier, redirect_uri, return_to, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(state, provider.id, verifier, redirectUri, returnTo, new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
      const url = new URL(disco.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', provider.client_id);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', provider.scopes || 'openid profile email');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      redirect(rc, url.toString());
    } catch (error) {
      redirect(rc, `/login?sso_error=${encodeURIComponent(error instanceof Error ? error.message : '统一认证启动失败')}`);
    }
  });

  // 账户页发起绑定（带当前人员 token）
  router.post('/api/account/sso/:providerId/start', async (rc) => {
    const person = requirePerson(rc);
    const provider = providerRow(rc.app.db, { id: rc.params.providerId });
    if (!provider || !provider.enabled) throw errors.notFound('认证源不存在或未启用');
    const disco = await discover(provider);
    const { verifier, challenge } = pkce();
    const state = randomToken(24);
    const redirectUri = `${baseUrl(rc)}/api/auth/sso/${encodeURIComponent(provider.slug)}/callback`;
    const now = Date.now();
    rc.app.db.prepare(
      `INSERT INTO auth_states (state, provider_id, verifier, redirect_uri, return_to, bind_person_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, '/account', ?, ?, ?)`,
    ).run(state, provider.id, verifier, redirectUri, person.id, new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
    const url = new URL(disco.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.client_id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', provider.scopes || 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    rc.json({ url: url.toString() });
  });

  router.get('/api/auth/sso/:slug/callback', async (rc) => {
    const provider = providerRow(rc.app.db, { slug: rc.params.slug });
    const params = rc.query(z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }));
    if (!provider) { redirect(rc, `/login?sso_error=${encodeURIComponent('认证源不存在')}`); return; }
    if (params.error) { redirect(rc, `/login?sso_error=${encodeURIComponent(params.error_description || params.error)}`); return; }
    if (!params.code || !params.state) { redirect(rc, `/login?sso_error=${encodeURIComponent('缺少 OAuth code/state')}`); return; }
    const state = rowOf<{ state: string; provider_id: string; verifier: string; redirect_uri: string; return_to: string; bind_person_id: string | null; expires_at: string }>(
      rc.app.db, 'SELECT * FROM auth_states WHERE state = ?', [params.state],
    );
    rc.app.db.prepare('DELETE FROM auth_states WHERE state = ?').run(params.state);
    if (!state || state.provider_id !== provider.id || state.expires_at <= nowIso()) {
      redirect(rc, `/login?sso_error=${encodeURIComponent('登录状态已过期，请重试')}`);
      return;
    }
    try {
      const disco = await discover(provider);
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: state.redirect_uri,
        client_id: provider.client_id,
        code_verifier: state.verifier,
      });
      if (provider.client_secret) body.set('client_secret', provider.client_secret);
      const tokenResponse = await fetch(disco.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const tokenData = await tokenResponse.json() as { access_token?: string; error_description?: string };
      if (!tokenResponse.ok || !tokenData.access_token) throw new Error(tokenData.error_description || 'OIDC token 交换失败');
      const userinfoResponse = await fetch(disco.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokenData.access_token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const userinfo = await userinfoResponse.json() as Record<string, unknown>;
      if (!userinfoResponse.ok) throw new Error('无法获取统一认证用户信息');
      const subject = String(userinfo.sub ?? userinfo.id ?? '').trim();
      if (!subject) throw new Error('统一认证返回缺少 subject');
      const email = typeof userinfo.email === 'string' ? userinfo.email.toLowerCase() : '';
      const name = String(userinfo.name ?? userinfo.preferred_username ?? email.split('@')[0] ?? '统一认证用户').slice(0, 120);

      let personId = state.bind_person_id;
      if (personId) {
        const existing = rowOf<{ person_id: string }>(
          rc.app.db, 'SELECT person_id FROM auth_identities WHERE provider_id = ? AND subject = ?', [provider.id, subject],
        );
        if (existing && existing.person_id !== personId) throw new Error('该统一认证账号已绑定其他人员');
        if (!existing) {
          rc.app.db.prepare(
            'INSERT INTO auth_identities (id, person_id, provider_id, subject, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(newId('idn'), personId, provider.id, subject, email || null, nowIso());
        }
        redirect(rc, `${state.return_to || '/account'}?sso=linked`);
        return;
      }

      let identity = rowOf<{ person_id: string }>(
        rc.app.db, 'SELECT person_id FROM auth_identities WHERE provider_id = ? AND subject = ?', [provider.id, subject],
      );
      if (!identity && email) {
        const byEmail = rowOf<{ id: string }>(rc.app.db, 'SELECT id FROM persons WHERE lower(email) = lower(?)', [email]);
        if (byEmail) personId = byEmail.id;
      }
      if (identity) personId = identity.person_id;
      if (!personId && provider.auto_create && email) {
        const id = newId('per');
        const now = nowIso();
        const uniqueEmail = email;
        rc.app.db.prepare(
          `INSERT INTO persons (id, email, name, title, avatar_color, is_admin, password_hash, password_set, created_at, last_seen_at)
           VALUES (?, ?, ?, '统一认证账号', 'violet', 0, ?, 0, ?, ?)`,
        ).run(id, uniqueEmail, name, hashPassword(randomToken(24)), now, now);
        personId = id;
      }
      if (!personId) throw new Error('没有匹配的人员账号；请联系管理员开通账号');
      if (!identity) {
        rc.app.db.prepare(
          'INSERT INTO auth_identities (id, person_id, provider_id, subject, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(newId('idn'), personId, provider.id, subject, email || null, nowIso());
      }
      const person = rowOf<Parameters<typeof personFromRow>[0]>(
        rc.app.db, 'SELECT * FROM persons WHERE id = ?', [personId],
      );
      if (!person) throw new Error('人员账号不存在');
      const token = createSession(rc.app.db, personId, rc.app.env.sessionTtlHours, rc);
      redirect(rc, `/login#token=${encodeURIComponent(token)}`);
    } catch (error) {
      redirect(rc, `/login?sso_error=${encodeURIComponent(error instanceof Error ? error.message : '统一认证登录失败')}`);
    }
  });

  router.get('/api/account', (rc) => {
    const person = requirePerson(rc);
    const identities = rowsOf<{
      id: string; provider_id: string; provider_name: string; provider_slug: string;
      subject: string; email: string | null; created_at: string;
    }>(
      rc.app.db,
      `SELECT i.id, i.provider_id, p.name AS provider_name, p.slug AS provider_slug,
              i.subject, i.email, i.created_at
         FROM auth_identities i JOIN auth_providers p ON p.id = i.provider_id
        WHERE i.person_id = ? ORDER BY i.created_at DESC`,
      [person.id],
    );
    const providers = rowsOf<ProviderRow>(rc.app.db, 'SELECT * FROM auth_providers WHERE enabled = 1 ORDER BY name').map((row) => ({
      id: row.id, slug: row.slug, name: row.name, type: 'oidc' as const,
    }));
    rc.json({
      person,
      hasPassword: person.hasPassword !== false,
      identities: identities.map((row) => ({
        id: row.id, providerId: row.provider_id, providerName: row.provider_name,
        providerSlug: row.provider_slug, subject: row.subject,
        ...(row.email ? { email: row.email } : {}), createdAt: row.created_at,
      })),
      availableProviders: providers,
    });
  });

  router.get('/api/account/api-keys', (rc) => {
    const person = requirePerson(rc);
    const rows = rowsOf<{ id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null }>(
      rc.app.db,
      `SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys
        WHERE person_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      [person.id],
    );
    rc.json({ keys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.key_prefix,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
    })) });
  });

  router.post('/api/account/api-keys', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(z.object({ name: z.string().trim().max(80).optional() }));
    const active = rowOf<{ c: number }>(rc.app.db, 'SELECT COUNT(*) AS c FROM api_keys WHERE person_id = ? AND revoked_at IS NULL', [person.id])?.c ?? 0;
    if (Number(active) >= 20) throw errors.badRequest('API Key 数量已达上限，请先删除不用的 Key');
    const key = `ryan_ak_${randomToken(24)}`;
    const id = newId('key');
    rc.app.db.prepare(
      'INSERT INTO api_keys (id, person_id, name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, person.id, input.name?.trim() || 'DSH 插件', key.slice(0, 16), sha256(key), nowIso());
    rc.json({ id, name: input.name?.trim() || 'DSH 插件', key, createdAt: nowIso() });
  });

  router.delete('/api/account/api-keys/:id', (rc) => {
    const person = requirePerson(rc);
    const key = rowOf<{ id: string }>(rc.app.db, 'SELECT id FROM api_keys WHERE id = ? AND person_id = ? AND revoked_at IS NULL', [rc.params.id!, person.id]);
    if (!key) throw errors.notFound('API Key 不存在');
    rc.app.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowIso(), key.id);
    rc.json({ ok: true });
  });

  router.patch('/api/account', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(z.object({
      name: z.string().trim().min(1).max(80).optional(),
      title: z.string().trim().max(120).optional(),
    }));
    rc.app.db.prepare('UPDATE persons SET name = ?, title = ? WHERE id = ?').run(
      input.name ?? person.name,
      input.title ?? person.title,
      person.id,
    );
    const row = rc.app.db.prepare('SELECT * FROM persons WHERE id = ?').get(person.id) as any;
    rc.json({ person: personFromRow(row) });
  });

  router.post('/api/account/password', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(z.object({ currentPassword: z.string().max(200).optional(), newPassword: z.string().min(8).max(200) }));
    const row = rc.app.db.prepare('SELECT password_hash, password_set FROM persons WHERE id = ?').get(person.id) as { password_hash: string; password_set: number };
    if (Number(row.password_set) === 1) {
      if (!input.currentPassword || !verifyPassword(input.currentPassword, row.password_hash)) {
        throw errors.unauthorized('当前密码不正确');
      }
    }
    rc.app.db.prepare('UPDATE persons SET password_hash = ?, password_set = 1 WHERE id = ?').run(hashPassword(input.newPassword), person.id);
    rc.json({ ok: true });
  });

  router.delete('/api/account/identities/:id', (rc) => {
    const person = requirePerson(rc);
    const count = rowOf<{ c: number }>(rc.app.db, 'SELECT COUNT(*) AS c FROM auth_identities WHERE person_id = ?', [person.id])?.c ?? 0;
    const row = rowOf<{ id: string }>(rc.app.db, 'SELECT id FROM auth_identities WHERE id = ? AND person_id = ?', [rc.params.id, person.id]);
    if (!row) throw errors.notFound('绑定不存在');
    if (person.hasPassword === false && Number(count) <= 1) throw errors.badRequest('至少保留一种登录方式');
    rc.app.db.prepare('DELETE FROM auth_identities WHERE id = ?').run(row.id);
    rc.json({ ok: true });
  });

  // 管理员账号管理
  router.get('/api/settings/accounts', (rc) => {
    requireAdmin(rc);
    const rows = rowsOf<{
      id: string; email: string; name: string; title: string; avatar_color: string;
      is_admin: number; password_set: number; created_at: string; last_seen_at: string | null;
      identity_count: number;
    }>(
      rc.app.db,
      `SELECT p.id, p.email, p.name, p.title, p.avatar_color, p.is_admin, p.password_set,
              p.created_at, p.last_seen_at,
              (SELECT COUNT(*) FROM auth_identities i WHERE i.person_id = p.id) AS identity_count
         FROM persons p ORDER BY p.is_admin DESC, p.created_at DESC`,
    );
    rc.json(rows.map((row) => ({
      ...personFromRow(row),
      identityCount: Number(row.identity_count),
    })));
  });

  router.post('/api/settings/accounts', async (rc) => {
    requireAdmin(rc);
    const input = await rc.body(z.object({
      name: z.string().trim().min(1).max(80),
      email: z.string().trim().email().max(200),
      title: z.string().trim().max(120).optional(),
      password: z.string().min(8).max(200),
      isAdmin: z.boolean().optional(),
    }));
    const existing = rowOf<{ id: string }>(rc.app.db, 'SELECT id FROM persons WHERE lower(email) = lower(?)', [input.email]);
    if (existing) throw errors.conflict('该邮箱已存在账号');
    const id = newId('per');
    rc.app.db.prepare(
      `INSERT INTO persons (id, email, name, title, avatar_color, is_admin, password_hash, password_set, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'violet', ?, ?, 1, ?, ?)`,
    ).run(id, input.email.toLowerCase(), input.name, input.title ?? '', input.isAdmin ? 1 : 0, hashPassword(input.password), nowIso(), nowIso());
    const row = rc.app.db.prepare('SELECT * FROM persons WHERE id = ?').get(id) as any;
    rc.json(personFromRow(row), 201);
  });

  router.delete('/api/settings/accounts/:id', (rc) => {
    const actor = requireAdmin(rc);
    const target = rowOf<{ id: string; is_admin: number; name: string }>(rc.app.db, 'SELECT id, is_admin, name FROM persons WHERE id = ?', [rc.params.id]);
    if (!target) throw errors.notFound('账号不存在');
    if (target.id === actor.id) throw errors.badRequest('不能删除自己的账号');
    if (Number(target.is_admin) === 1) {
      const admins = rowOf<{ c: number }>(rc.app.db, 'SELECT COUNT(*) AS c FROM persons WHERE is_admin = 1')?.c ?? 0;
      if (admins <= 1) throw errors.badRequest('至少保留一个管理员账号');
    }
    const owned = rowOf<{ c: number }>(rc.app.db, 'SELECT COUNT(*) AS c FROM projects WHERE owner_person_id = ?', [target.id])?.c ?? 0;
    if (Number(owned) > 0) throw errors.badRequest(`该账号名下还有 ${owned} 个项目，请先转移项目所有权`);
    rc.app.db.prepare('DELETE FROM persons WHERE id = ?').run(target.id);
    rc.json({ ok: true });
  });

  router.patch('/api/settings/accounts/:id', async (rc) => {
    const actor = requireAdmin(rc);
    const target = rowOf<{ id: string; is_admin: number }>(rc.app.db, 'SELECT id, is_admin FROM persons WHERE id = ?', [rc.params.id]);
    if (!target) throw errors.notFound('账号不存在');
    const input = await rc.body(z.object({
      name: z.string().trim().min(1).max(80).optional(),
      title: z.string().trim().max(120).optional(),
      isAdmin: z.boolean().optional(),
      password: z.string().min(8).max(200).optional(),
    }));
    if (input.isAdmin === false && Number(target.is_admin) === 1) {
      const admins = rowOf<{ c: number }>(rc.app.db, 'SELECT COUNT(*) AS c FROM persons WHERE is_admin = 1')?.c ?? 0;
      if (admins <= 1) throw errors.badRequest('至少保留一个管理员账号');
      if (target.id === actor.id) throw errors.badRequest('不能取消自己的管理员权限');
    }
    rc.app.db.prepare(
      'UPDATE persons SET name = COALESCE(?, name), title = COALESCE(?, title), is_admin = COALESCE(?, is_admin) WHERE id = ?',
    ).run(input.name ?? null, input.title ?? null, input.isAdmin === undefined ? null : input.isAdmin ? 1 : 0, target.id);
    if (input.password) {
      rc.app.db.prepare('UPDATE persons SET password_hash = ?, password_set = 1 WHERE id = ?').run(hashPassword(input.password), target.id);
    }
    const row = rc.app.db.prepare('SELECT * FROM persons WHERE id = ?').get(target.id) as any;
    rc.json(personFromRow(row));
  });

  // 管理员认证源管理
  router.get('/api/settings/auth-providers', (rc) => {
    requireAdmin(rc);
    rc.json(rowsOf<ProviderRow>(rc.app.db, 'SELECT * FROM auth_providers ORDER BY name').map(publicProvider));
  });

  router.post('/api/settings/auth-providers', async (rc) => {
    requireAdmin(rc);
    const input = await rc.body(z.object({
      name: z.string().trim().min(1).max(80),
      slug: z.string().trim().min(1).max(50).regex(/^[a-z0-9][a-z0-9-]*$/),
      issuer: z.string().url(),
      clientId: z.string().trim().min(1).max(300),
      clientSecret: z.string().max(500).optional(),
      scopes: z.string().trim().max(300).optional(),
      enabled: z.boolean().optional(),
      autoCreate: z.boolean().optional(),
    }));
    const id = newId('idp');
    const now = nowIso();
    rc.app.db.prepare(
      `INSERT INTO auth_providers (id, slug, name, type, issuer, client_id, client_secret, scopes, enabled, auto_create, created_at, updated_at)
       VALUES (?, ?, ?, 'oidc', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.slug, input.name, input.issuer.replace(/\/+$/, ''), input.clientId,
      input.clientSecret ?? '', input.scopes ?? 'openid profile email',
      input.enabled === false ? 0 : 1, input.autoCreate === false ? 0 : 1, now, now,
    );
    rc.json(publicProvider(providerRow(rc.app.db, { id })!), 201);
  });

  router.patch('/api/settings/auth-providers/:id', async (rc) => {
    requireAdmin(rc);
    const provider = providerRow(rc.app.db, { id: rc.params.id });
    if (!provider) throw errors.notFound('认证源不存在');
    const input = await rc.body(z.object({
      name: z.string().trim().min(1).max(80).optional(),
      issuer: z.string().url().optional(),
      clientId: z.string().trim().min(1).max(300).optional(),
      clientSecret: z.string().max(500).optional(),
      scopes: z.string().trim().max(300).optional(),
      enabled: z.boolean().optional(),
      autoCreate: z.boolean().optional(),
    }));
    rc.app.db.prepare(
      `UPDATE auth_providers SET name = ?, issuer = ?, client_id = ?, client_secret = ?, scopes = ?, enabled = ?, auto_create = ?, updated_at = ? WHERE id = ?`,
    ).run(
      input.name ?? provider.name,
      input.issuer ? input.issuer.replace(/\/+$/, '') : provider.issuer,
      input.clientId ?? provider.client_id,
      input.clientSecret === undefined || input.clientSecret === '' ? provider.client_secret : input.clientSecret,
      input.scopes ?? provider.scopes,
      input.enabled === undefined ? provider.enabled : input.enabled ? 1 : 0,
      input.autoCreate === undefined ? provider.auto_create : input.autoCreate ? 1 : 0,
      nowIso(), provider.id,
    );
    discoveryCache.delete(provider.id);
    rc.json(publicProvider(providerRow(rc.app.db, { id: provider.id })!));
  });

  router.delete('/api/settings/auth-providers/:id', (rc) => {
    requireAdmin(rc);
    const provider = providerRow(rc.app.db, { id: rc.params.id });
    if (!provider) throw errors.notFound('认证源不存在');
    rc.app.db.prepare('DELETE FROM auth_providers WHERE id = ?').run(provider.id);
    rc.json({ ok: true });
  });
}
