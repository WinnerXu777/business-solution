import { stat } from 'node:fs/promises';
import pg from 'pg';
import { createApp } from '../app.ts';
import { installSecurity } from '../security/index.ts';
import { installOps } from './plugin.ts';

const { DATABASE_URL, BS_WEB_ORIGIN, BS_EDGE_IP, BS_WORKER_SOCKET } = process.env;
if (!DATABASE_URL || !BS_WEB_ORIGIN || !BS_EDGE_IP || !BS_WORKER_SOCKET) {
  throw new Error('Missing deployment configuration.');
}

const app = createApp();
installSecurity(app, {
  allowedOrigins: [BS_WEB_ORIGIN],
  sessionOrigin: BS_WEB_ORIGIN,
  trustedProxyIp: BS_EDGE_IP,
});

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 750,
  statement_timeout: 750,
  query_timeout: 750,
});
pool.on('error', () => app.log.error('Readiness database connection failed'));
app.addHook('onClose', () => pool.end());
installOps(app, {
  checks: {
    database: async () => {
      const { rowCount } = await pool.query(
        "SELECT 1 FROM demo_fixture.sales_order WHERE tenant_id = 'tenant-rivetquay' AND id = 'ord-001' AND EXISTS (SELECT 1 FROM governance.migration)",
      );
      return rowCount === 1;
    },
    queue: async () => (await stat(BS_WORKER_SOCKET)).isSocket(),
    providers: () => true, // This entry point uses the in-process fixture providers.
  },
});

await app.listen({ host: '0.0.0.0', port: 3000 });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
