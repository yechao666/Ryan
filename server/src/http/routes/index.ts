import type { AppContext } from '../../contracts.ts';
import type { Router } from '../router.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerIdentityRoutes } from './identity.ts';
import { registerTaskRoutes } from './tasks.ts';
import { registerRuntimeRoutes } from './runtime.ts';
import { registerAutomationRoutes } from './automations.ts';
import { registerIntegrationRoutes } from './integrations.ts';
import { registerMemoryRoutes } from './memory.ts';
import { registerEventRoutes } from './events.ts';
import { registerAssistantRoutes } from './assistant.ts';
import { registerPromptCardRoutes } from './prompt-cards.ts';
import { registerSettingsRoutes } from './settings.ts';
import { registerInstanceRoutes } from './instances.ts';

export function registerRoutes(router: Router, _app: AppContext): void {
  registerAuthRoutes(router);
  registerIdentityRoutes(router);
  registerTaskRoutes(router);
  registerRuntimeRoutes(router);
  registerAutomationRoutes(router);
  registerIntegrationRoutes(router);
  registerMemoryRoutes(router);
  registerEventRoutes(router);
  registerAssistantRoutes(router);
  registerPromptCardRoutes(router);
  registerSettingsRoutes(router);
  registerInstanceRoutes(router);
}
