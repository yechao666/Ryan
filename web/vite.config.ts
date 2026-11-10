import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(root, 'shared/src/index.ts'),
      '@ui': resolve(here, 'src/components/ui/index.tsx'),
      '@charts': resolve(here, 'src/components/charts/index.tsx'),
      '@lib': resolve(here, 'src/lib'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(here, 'node_modules/@changfenhuang/dsh-genui/src/client/standalone/primitive-adapter.tsx'),
    },
  },
  server: {
    port: 4501,
    strictPort: true,
    fs: { allow: [root] },
    proxy: { '/api': { target: 'http://127.0.0.1:4500', changeOrigin: true } },
  },
  build: { outDir: resolve(here, 'dist'), emptyOutDir: true, target: 'es2022' },
});
