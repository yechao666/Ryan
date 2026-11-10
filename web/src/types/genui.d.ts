declare module '@changfenhuang/dsh-genui/embed' {
  import type { ComponentType, ReactNode } from 'react';

  export interface GenuiProcessed {
    spec: unknown | null;
    errors: string[];
    warnings?: unknown[];
  }

  export function processGenuiSpec(value: unknown, options?: Record<string, unknown>): GenuiProcessed;
  export const GenuiBlock: ComponentType<{
    spec: unknown;
    stateKey?: string;
    onAction?: (action: string, payload: Record<string, unknown>) => void;
    animateEntrance?: boolean;
  }>;
  export const GenuiActionContext: import('react').Context<((action: string, payload: Record<string, unknown>) => void) | undefined>;
  export function setGenuiAssetBase(base: string): void;
  export function renderInline(text: string): ReactNode;
}
