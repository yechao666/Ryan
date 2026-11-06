import type { RequestContext } from './context.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: (rc: RequestContext) => void | Promise<void>;
}

interface CompiledRoute extends RouteDefinition {
  segments: string[];
}

export type RouteMatch = { route: CompiledRoute; params: Record<string, string> };
const METHOD_MISMATCH = 'METHOD_MISMATCH';

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  let value = pathname;
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value || '/';
}

export class Router {
  private routes: CompiledRoute[] = [];

  add(definition: RouteDefinition): void {
    this.routes.push({ ...definition, path: normalizePath(definition.path), segments: split(definition.path) });
  }

  get(path: string, handler: RouteDefinition['handler']): void {
    this.add({ method: 'GET', path, handler });
  }
  post(path: string, handler: RouteDefinition['handler']): void {
    this.add({ method: 'POST', path, handler });
  }
  patch(path: string, handler: RouteDefinition['handler']): void {
    this.add({ method: 'PATCH', path, handler });
  }
  put(path: string, handler: RouteDefinition['handler']): void {
    this.add({ method: 'PUT', path, handler });
  }
  delete(path: string, handler: RouteDefinition['handler']): void {
    this.add({ method: 'DELETE', path, handler });
  }

  match(method: string, pathname: string): RouteMatch | typeof METHOD_MISMATCH | null {
    const target = split(normalizePath(pathname));
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.segments.length !== target.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i]!;
        const value = target[i]!;
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const routeMethod = route.method === 'HEAD' ? 'GET' : route.method;
      if (routeMethod !== method) {
        methodMismatch = true;
        continue;
      }
      return { route, params };
    }
    return methodMismatch ? METHOD_MISMATCH : null;
  }
}

export { METHOD_MISMATCH };
