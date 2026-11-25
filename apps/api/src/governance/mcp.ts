import { randomUUID } from 'node:crypto';
import type { CallEnvelope, ToolCall, ToolName } from '@bs/contracts';
import type { ToolGateway } from '@bs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { catalog, idSchema, isObject, validates } from './catalog.ts';
import type { VerifiedIdentity } from './identity.ts';

const protocolVersions = ['2025-06-18', '2025-03-26'];
const tools = Array.from(catalog, ([name, { inputSchema, outputSchema }]) => ({
  name,
  inputSchema,
  outputSchema,
}));

function error(
  reply: FastifyReply,
  status: number,
  id: string | number | null,
  code: number,
  message: string,
) {
  return reply.code(status).send({ jsonrpc: '2.0', id, error: { code, message } });
}

function allowsJson(accept: string | undefined) {
  return accept?.split(',').some((item) => {
    const [type, ...parameters] = item.trim().split(';');
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    return (
      ['application/json', 'application/*', '*/*'].includes(type.toLowerCase()) &&
      (quality === undefined || Number(quality.trim().slice(2)) > 0)
    );
  });
}

export function registerMcp(
  app: FastifyInstance,
  gateway: ToolGateway,
  identityOf: (request: FastifyRequest) => VerifiedIdentity,
  allowedOrigins: readonly string[],
) {
  function originAllowed(request: FastifyRequest) {
    return request.headers.origin === undefined || allowedOrigins.includes(request.headers.origin);
  }

  app.route({
    url: '/mcp',
    method: ['GET', 'DELETE'],
    handler(request, reply) {
      if (!originAllowed(request)) return reply.code(403).send();
      // This stateless server returns one JSON response per POST.
      return reply.header('Allow', 'POST').code(405).send();
    },
  });

  app.post('/mcp', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send();
    if (!allowsJson(request.headers.accept)) {
      return error(reply, 406, null, -32600, 'Accept must allow application/json.');
    }
    const body = request.body;
    if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return error(reply, 400, null, -32600, 'Invalid Request');
    }
    const id = body.id;
    if (id !== undefined && typeof id !== 'number' && typeof id !== 'string') {
      return error(reply, 400, null, -32600, 'Invalid Request');
    }
    const version = request.headers['mcp-protocol-version'];
    if (
      version !== undefined &&
      (typeof version !== 'string' || !protocolVersions.includes(version))
    ) {
      return error(reply, 400, id ?? null, -32600, 'Unsupported MCP protocol version.');
    }
    if (id === undefined) return reply.code(202).send();
    const respond = (result: unknown) => reply.send({ jsonrpc: '2.0', id, result });
    switch (body.method) {
      case 'initialize': {
        if (!isObject(body.params) || typeof body.params.protocolVersion !== 'string') {
          return error(reply, 200, id, -32602, 'Invalid params');
        }
        const requested = body.params.protocolVersion;
        return respond({
          protocolVersion: protocolVersions.includes(requested) ? requested : protocolVersions[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'rivetquay-governance', version: '1.0.0' },
        });
      }
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools });
      case 'tools/call': {
        const params = body.params;
        if (
          !isObject(params) ||
          typeof params.name !== 'string' ||
          Object.keys(params).some((field) => !['name', 'arguments', '_meta'].includes(field))
        ) {
          return error(reply, 200, id, -32602, 'Invalid params');
        }
        const name = params.name as ToolName;
        const tool = catalog.get(name);
        const input = params.arguments === undefined ? {} : params.arguments;
        if (!tool || !validates(request, tool.inputSchema, input)) {
          return error(reply, 200, id, -32602, 'Unknown tool or invalid arguments');
        }
        const createdId = randomUUID();
        const key = request.headers['idempotency-key'] ?? createdId;
        if (typeof key !== 'string' || !validates(request, idSchema, key)) {
          return error(reply, 200, id, -32602, 'Invalid Idempotency-Key');
        }
        const envelope: CallEnvelope = {
          ...identityOf(request),
          version: 'v1',
          source: 'mcp',
          traceId: createdId,
          correlationId: createdId,
          idempotencyKey: key,
        };
        const result = await gateway.call({ tool: name, input, envelope } as ToolCall);
        return respond({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError:
            result.state === 'denied' || result.state === 'failed' || result.state === 'unknown',
        });
      }
      default:
        return error(reply, 200, id, -32601, 'Method not found');
    }
  });
}
