import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: {
    proxy: { '/automation': 'http://127.0.0.1:' + (process.env.API_PORT ?? '3000') },
  },
});
