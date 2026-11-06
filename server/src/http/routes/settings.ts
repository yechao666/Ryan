import { z } from 'zod';
import type { Router } from '../router.ts';
import { requireAdmin, requirePerson } from '../auth.ts';
import { getAssistantSettings, getSecuritySettings, getSystemSettings, setAssistantSettings, setSecuritySettings } from '../../settings/system.ts';

const securityInputSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().max(1000).optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(2000).optional(),
  timeoutMs: z.number().int().min(500).max(60_000).optional(),
  blockMessage: z.string().max(1000).optional(),
});

const assistantInputSchema = z.object({
  enabled: z.boolean().optional(),
  instanceId: z.string().max(80).nullable().optional(),
  model: z.string().max(200).optional(),
});

export function registerSettingsRoutes(router: Router): void {
  router.get('/api/settings', (rc) => {
    requirePerson(rc);
    rc.json(getSystemSettings(rc.app.db));
  });

  router.patch('/api/settings/security', async (rc) => {
    const person = requireAdmin(rc);
    const input = await rc.body(securityInputSchema);
    rc.json({ security: setSecuritySettings(rc.app.db, input, person.id) });
  });

  router.patch('/api/settings/assistant', async (rc) => {
    const person = requireAdmin(rc);
    const input = await rc.body(assistantInputSchema);
    const current = getAssistantSettings(rc.app.db);
    rc.json({ assistant: setAssistantSettings(rc.app.db, { ...current, ...input, instanceId: input.instanceId ?? current.instanceId }, person.id) });
  });

  router.post('/api/settings/security/test', async (rc) => {
    requireAdmin(rc);
    const settings = getSecuritySettings(rc.app.db);
    if (!settings.enabled || !settings.endpoint) {
      rc.json({ ok: true, skipped: true, message: '安全检查未启用（endpoint 为空）' });
      return;
    }
    const started = Date.now();
    try {
      const response = await fetch(settings.endpoint.replace(/\/+$/, '').endsWith('/chat/completions') ? settings.endpoint : `${settings.endpoint.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
        body: JSON.stringify({ model: settings.model || 'security-check', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      rc.json({ ok: response.ok, status: response.status, latencyMs: Date.now() - started });
    } catch (error) {
      rc.json({ ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started });
    }
  });
}
