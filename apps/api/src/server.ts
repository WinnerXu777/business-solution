import { createApp } from './app.ts';

const port = Number(process.env.API_PORT ?? '3000');
await createApp().listen({ host: '127.0.0.1', port });
