import type { Context } from './dsh-types.js';
import { type RawRyanPluginConfig } from './config.js';
export declare const name = "dsh-ryan";
export declare const inject: string[];
export { Config, RYAN_SETTINGS_NAMESPACE, resolveConfig } from './config.js';
export declare function apply(ctx: Context, config?: RawRyanPluginConfig): void;
