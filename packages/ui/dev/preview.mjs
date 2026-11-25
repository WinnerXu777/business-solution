import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use the Vite installation already available to Vitest.
const testDependency = createRequire(import.meta.resolve('vitest'));
const { createServer } = await import(pathToFileURL(testDependency.resolve('vite')).href);
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('./', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1' },
});
await server.listen();
server.printUrls();
