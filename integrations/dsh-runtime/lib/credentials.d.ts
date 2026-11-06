import type { HiveRuntimeConfig } from './config.js';
export interface CredentialResolution {
    apiKey?: string;
    source: 'environment' | 'credentials-file' | 'missing';
    file?: string;
}
export declare function resolveDeepseekApiKey(config: HiveRuntimeConfig): Promise<CredentialResolution>;
