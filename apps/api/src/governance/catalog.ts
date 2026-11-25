import { isDeepStrictEqual } from 'node:util';
import { toolModules, type ToolName } from '@bs/contracts';
import contracts from '@bs/contracts/v1/schema' with { type: 'json' };
import openapi from '@bs/contracts/v1/openapi' with { type: 'json' };
import type { FastifyRequest } from 'fastify';

type Schema = { [key: string]: unknown };
const definitions: Record<string, Schema> = contracts.$defs;

function schema(name: string): Schema {
  const definition = definitions[name];
  const target = definition.$ref;
  if (typeof target === 'string' && target.startsWith('#/$defs/')) {
    return schema(target.slice('#/$defs/'.length));
  }
  const referenced: Record<string, Schema> = {};
  function collect(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (isObject(value)) {
      const ref = value.$ref;
      if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
        const name = ref.slice('#/$defs/'.length);
        if (Object.hasOwn(referenced, name)) return;
        referenced[name] = definitions[name];
        collect(definitions[name]);
      }
      Object.values(value).forEach(collect);
    }
  }
  collect(definition);
  return { ...definition, $defs: referenced };
}

export const idSchema = schema('Id');
export const envelopeSchema = schema('CallEnvelope');

export const catalog = new Map(
  (Object.keys(toolModules) as ToolName[]).map((tool) => {
    const path = `/v1/tools/${tool}` as const;
    const { operationId } = openapi.paths[path].post;
    return [
      tool,
      {
        path,
        requestSchema: schema(operationId + 'Request'),
        inputSchema: schema(operationId + 'Input'),
        outputSchema: { type: 'object', ...schema(operationId + 'Result') },
      },
    ] as const;
  }),
);

export function validates(request: FastifyRequest, definition: Schema, input: unknown) {
  // Default Fastify validation may coerce values or remove unknown fields.
  // Accept the original wire payload only if validation leaves it intact.
  const copy = structuredClone(input);
  return (
    request.compileValidationSchema(definition)(copy) === true && isDeepStrictEqual(copy, input)
  );
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
