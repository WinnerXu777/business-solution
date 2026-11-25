#!/usr/bin/env node
import { createConnection } from 'node:net';

const socket = createConnection(process.env.BS_WORKER_SOCKET);
socket.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
  process.stdin.destroy();
});
socket.on('close', () => process.stdin.destroy());
process.stdin.pipe(socket);
socket.pipe(process.stdout);
