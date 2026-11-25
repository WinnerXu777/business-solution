import type { ToolCall, ToolResultMap } from '@bs/contracts';
import type { ToolGateway } from '@bs/core';
import type { Tracer } from '../../../../packages/core/src/observability/index.ts';

/** Apply after the transport resolves identity and validates the call envelope. */
export function instrumentGatewayCall(
  tracer: Tracer,
  call: ToolGateway['call'],
): ToolGateway['call'] {
  return async <Request extends ToolCall>(
    request: Request,
  ): Promise<ToolResultMap[Request['tool']]> => {
    const span = tracer.startSpan('tool.' + request.tool, { envelope: request.envelope });
    try {
      const result = await tracer.run(span, () => call(request));
      span.end(result.state === 'failed' || result.state === 'unknown' ? 'error' : 'ok', {
        'tool.outcome': result.state,
      });
      return result;
    } catch (error) {
      span.end('error', { 'error.type': 'gateway_exception' });
      throw error;
    }
  };
}
