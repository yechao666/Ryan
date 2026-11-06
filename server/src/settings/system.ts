import type { Db } from '../db/index.ts';
import type { AssistantSettings, SecuritySettings, SystemSettings } from '../../../shared/src/types.ts';
import { DEFAULT_SECURITY_SETTINGS } from '../../../shared/src/constants.ts';

interface SettingsRow { key: string; value: string; updated_by: string | null; updated_at: string }

function readRow(db: Db, key: string): SettingsRow | null {
  return (db.prepare('SELECT * FROM system_settings WHERE key = ?').get(key) as unknown as SettingsRow | undefined) ?? null;
}

export function getRawSetting<T>(db: Db, key: string, fallback: T): T {
  const row = readRow(db, key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setRawSetting(db: Db, key: string, value: unknown, updatedBy?: string | null): void {
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), updatedBy ?? null, new Date().toISOString());
}

export function getSecuritySettings(db: Db): SecuritySettings & { apiKey?: string } {
  const stored = getRawSetting<Partial<SecuritySettings> & { apiKey?: string }>(db, 'security', {});
  const endpoint = typeof stored.endpoint === 'string' ? stored.endpoint.trim() : '';
  return {
    enabled: Boolean(endpoint) && stored.enabled !== false,
    endpoint,
    model: typeof stored.model === 'string' ? stored.model : '',
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
    apiKeyConfigured: Boolean(stored.apiKey),
    timeoutMs: Number.isFinite(stored.timeoutMs) ? Number(stored.timeoutMs) : DEFAULT_SECURITY_SETTINGS.timeoutMs,
    blockMessage: typeof stored.blockMessage === 'string' && stored.blockMessage.trim()
      ? stored.blockMessage
      : DEFAULT_SECURITY_SETTINGS.blockMessage,
  };
}

export function publicSecuritySettings(db: Db): SecuritySettings {
  const { apiKey: _apiKey, ...rest } = getSecuritySettings(db);
  return rest;
}

export function getAssistantSettings(db: Db): AssistantSettings {
  return getRawSetting<AssistantSettings>(db, 'assistant', { enabled: true });
}

export function getSystemSettings(db: Db): SystemSettings {
  const row = db.prepare("SELECT updated_at, updated_by FROM system_settings WHERE key IN ('security','assistant') ORDER BY updated_at DESC LIMIT 1").get() as unknown as
    | { updated_at: string; updated_by: string | null }
    | undefined;
  return {
    security: publicSecuritySettings(db),
    assistant: getAssistantSettings(db),
    updatedAt: row?.updated_at,
    updatedBy: row?.updated_by ?? undefined,
  };
}

export function setSecuritySettings(
  db: Db,
  input: Partial<SecuritySettings> & { apiKey?: string },
  updatedBy: string,
): SecuritySettings {
  const current = getSecuritySettings(db);
  const endpoint = input.endpoint === undefined ? current.endpoint : String(input.endpoint).trim();
  const apiKey = input.apiKey === undefined || input.apiKey === '' ? current.apiKey ?? '' : input.apiKey;
  setRawSetting(
    db,
    'security',
    {
      endpoint,
      enabled: Boolean(endpoint) && (input.enabled ?? current.enabled),
      model: input.model ?? current.model,
      apiKey,
      timeoutMs: input.timeoutMs ?? current.timeoutMs,
      blockMessage: input.blockMessage ?? current.blockMessage,
    },
    updatedBy,
  );
  return publicSecuritySettings(db);
}

export function setAssistantSettings(db: Db, input: AssistantSettings, updatedBy: string): AssistantSettings {
  const current = getAssistantSettings(db);
  const next = { ...current, ...input };
  setRawSetting(db, 'assistant', next, updatedBy);
  return next;
}
