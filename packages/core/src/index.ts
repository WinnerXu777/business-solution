import type { ToolCall, ToolResultMap } from '@bs/contracts';

export interface ToolGateway {
  call<Request extends ToolCall>(request: Request): Promise<ToolResultMap[Request['tool']]>;
}

export { FakeGateway } from './fake-gateway.ts';
