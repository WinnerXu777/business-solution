import { createInterface } from 'node:readline';
import type { ToolCall } from '@bs/contracts';
import { FakeGateway } from './fake-gateway.ts';

// Local fixture transport for worker smoke tests. One process owns one fixture session.
const gateway = new FakeGateway();
const input = createInterface({ input: process.stdin, terminal: false });
for await (const line of input) {
  try {
    const result = await gateway.call(JSON.parse(line) as ToolCall);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stdout.write(
      JSON.stringify({
        state: 'failed',
        code: 'invalid_input',
        message: 'Invalid fixture request.',
        retryable: false,
      }) + '\n',
    );
  }
}
