import { createApp } from './app.ts';

import { localDexAuth } from './auth-bootstrap.ts';
import { platformLlm } from './llm-bootstrap.ts';

const port = Number(process.env.API_PORT ?? '3000');
const app = createApp(process.env, {
  auth: localDexAuth(process.env),
  fixtureConnectors: true,
  llm: platformLlm,
});
await app.listen({ host: process.env.API_HOST ?? '127.0.0.1', port });
console.log('Fixture API listening at ' + app.listeningOrigin);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}
