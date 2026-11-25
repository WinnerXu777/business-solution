import { defineConfig } from 'vite';

const target =
  process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:' + (process.env.API_PORT ?? '3000');

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: {
    proxy: {
      '/platform/v1': target,
      '/automation': target,
      '/v1': target,
      '/mcp': target,
      '/connectors': target,
      '/llm': target,
    },
  },
});
