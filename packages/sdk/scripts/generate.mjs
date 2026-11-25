import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const root = new URL('../../../', import.meta.url);
const output = new URL('../src/generated/', import.meta.url);
const check = process.argv.includes('--check');
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const [rest, contract, platform] = await Promise.all([
  readJson('packages/contracts/v1/openapi.json'),
  readJson('packages/contracts/v1/contracts.schema.json'),
  readJson('apps/api/src/platform/openapi.json'),
]);

function schemaType(schema, namespace = '') {
  if (schema === true || schema === undefined) return 'unknown';
  if (schema === false) return 'never';
  const convert = (child) => schemaType(child, namespace);
  if (schema.$ref) {
    const match = schema.$ref.match(/^#\/(?:\$defs|components\/schemas)\/(\w+)$/);
    if (!match) throw new Error('Unsupported schema reference ' + schema.$ref);
    return namespace + match[1];
  }
  if ('const' in schema) return JSON.stringify(schema.const);
  const union = schema.oneOf ?? schema.anyOf;
  if (union) return union.map(convert).join(' | ');
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  switch (schema.type) {
    case 'array':
      return `Array<${convert(schema.items)}>`;
    case 'object': {
      const fields = Object.entries(schema.properties ?? {}).map(
        ([name, field]) =>
          `${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${convert(field)};`,
      );
      if (schema.additionalProperties && fields.length === 0) {
        return `Record<string, ${convert(schema.additionalProperties)}>`;
      }
      if (schema.additionalProperties) fields.push('[key: string]: unknown;');
      return fields.length ? `{ ${fields.join(' ')} }` : 'Record<string, unknown>';
    }
    case 'integer':
    case 'number':
      return 'number';
    case 'string':
    case 'boolean':
    case 'null':
      return schema.type;
    default:
      throw new Error('Unsupported schema ' + JSON.stringify(schema));
  }
}

const aliases = (schemas) =>
  Object.entries(schemas).map(([name, schema]) => `export type ${name} = ${schemaType(schema)};`);
const jsonSchema = (entry) => entry?.content?.['application/json']?.schema;
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);
function operations(document) {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => methods.has(method))
      .map(([method, operation]) => ({
        ...operation,
        path,
        method: method.toUpperCase(),
        parameters: [...(item.parameters ?? []), ...(operation.parameters ?? [])],
        responses: Object.entries(operation.responses).filter(([status]) => /^2\d\d$/.test(status)),
      })),
  );
}

function platformOperation(op) {
  const { operationId, method, parameters, responses } = op;
  if (!operationId) throw new Error('Missing operation ID for ' + op.path);
  const path = op.path.replaceAll(
    /\{(\w+)\}/g,
    (_, name) => '${pathSegment(args.path.' + name + ')}',
  );
  const groups = ['path', 'query'].flatMap((location) => {
    const fields = parameters.filter((param) => param.in === location);
    if (!fields.length) return [];
    return [
      {
        name: location,
        required: fields.some((param) => param.required),
        type: schemaType({
          type: 'object',
          properties: Object.fromEntries(fields.map((param) => [param.name, param.schema])),
          required: fields.filter((param) => param.required).map((param) => param.name),
        }),
      },
    ];
  });
  if (op.requestBody) {
    groups.push({
      name: 'body',
      required: op.requestBody.required,
      type: schemaType(jsonSchema(op.requestBody)),
    });
  }
  const typeName = operationId[0].toUpperCase() + operationId.slice(1);
  const request = `${typeName}Request`;
  const response = `${typeName}Response`;
  const requestFields = groups.map(
    ({ name, required, type }) => `${name}${required ? '' : '?'}: ${type};`,
  );
  requestFields.push('options?: CallOptions;');
  const outcome = [
    ...new Set(
      responses.map(([, value]) => (jsonSchema(value) ? schemaType(jsonSchema(value)) : 'void')),
    ),
  ].join(' | ');
  if (!outcome) throw new Error('Missing success response for ' + op.path);
  const transfer = groups
    .filter(({ name }) => name !== 'path')
    .map(({ name }) => `${name}: args.${name},`);
  const authFlow =
    op.path.startsWith('/platform/v1/auth/') || operationId === 'acceptPlatformInvite';
  return {
    types: `export type ${request} = { ${requestFields.join(' ')} };\nexport type ${response} = ${outcome};`,
    method: `${operationId}(args: ${request}${groups.some(({ required }) => required) ? '' : ' = {}'}) {
      return http.json<${response}>(\`${path}\`, {
        ...args.options, method: '${method}', ${transfer.join(' ')} ${authFlow ? "auth: 'omit', retry: 'never'," : ''}
      });
    },`,
  };
}

const platformOperations = operations(platform);
const platformOps = platformOperations.map(platformOperation);
const platformHasPathParams = platformOperations.some((op) => op.path.includes('{'));
const toolOps = operations(rest).map((op) => {
  const request = jsonSchema(op.requestBody)?.$ref?.split('/').at(-1);
  const response = jsonSchema(op.responses[0]?.[1])?.$ref?.split('/').at(-1);
  const tool = contract.$defs[request]?.properties.tool?.enum?.[0];
  if (
    !tool ||
    !contract.$defs[response] ||
    op.path !== '/v1/tools/' + tool ||
    op.method !== 'POST'
  ) {
    throw new Error('Governed contract does not match OpenAPI operation ' + op.path);
  }
  return {
    tool,
    request,
    response,
    path: op.path,
    method: op.operationId[0].toLowerCase() + op.operationId.slice(1),
  };
});

const files = {
  'contracts.ts': aliases(contract.$defs).join('\n'),
  'platform.ts': [
    `import { ${platformHasPathParams ? 'pathSegment, ' : ''}type CallOptions, type HttpClient } from '../http.ts';`,
    ...aliases(platform.components.schemas),
    ...platformOps.map((op) => op.types),
    `export function createPlatformClient(http: HttpClient) {
      return { ${platformOps.map((op) => op.method).join('\n')} };
    }`,
  ].join('\n'),
  'tools.ts': `
    import type * as C from './contracts.ts';
    import type { CallOptions, HttpClient } from '../http.ts';
    import { unwrapTool, type ToolSuccess } from '../errors.ts';

    export type ToolRequests = { ${toolOps.map(({ tool, request }) => `'${tool}': C.${request};`).join('\n')} };
    export type ToolResults = { ${toolOps.map(({ tool, response }) => `'${tool}': C.${response};`).join('\n')} };
    const paths = { ${toolOps.map(({ tool, path }) => `'${tool}': '${path}',`).join('\n')} } as const;
    export type ToolName = keyof ToolRequests;
    export type ToolInput<Name extends ToolName> = ToolRequests[Name]['input'];
    export const toolNames: readonly ToolName[] = Object.freeze(Object.keys(paths) as ToolName[]);
    export const isToolName = (value: string): value is ToolName => Object.hasOwn(paths, value);

    export function createToolsClient(http: HttpClient, envelope: (options?: CallOptions) => Promise<C.CallEnvelope>) {
      async function callRaw<Name extends ToolName>(tool: Name, input: NoInfer<ToolInput<Name>>, options?: CallOptions): Promise<ToolResults[Name]> {
        const scope = await envelope(options);
        return http.json(paths[tool], {
          ...options, method: 'POST', body: { envelope: scope, tool, input },
          idempotencyKey: scope.idempotencyKey, retry: 'keyed',
        });
      }
      async function call<Name extends ToolName>(tool: Name, input: NoInfer<ToolInput<Name>>, options?: CallOptions): Promise<ToolSuccess<ToolResults[Name]>> {
        return unwrapTool(await callRaw(tool, input, options));
      }
      return {
        call, callRaw,
        ${toolOps
          .map(
            ({ tool, method }) =>
              `${method}: (input: ToolInput<'${tool}'>, options?: CallOptions) => call('${tool}', input, options),`,
          )
          .join('\n')}
      };
    }
  `,
};

const style = await resolveConfig(fileURLToPath(new URL('package.json', root)));
if (!check) await mkdir(output, { recursive: true });
for (const [name, source] of Object.entries(files)) {
  const file = new URL(name, output);
  const expected = await format('// Generated by packages/sdk/scripts/generate.mjs.\n' + source, {
    ...style,
    parser: 'typescript',
  });
  if (!check) await writeFile(file, expected);
  else {
    const actual = await readFile(file, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (actual?.replaceAll('\r\n', '\n') !== expected) {
      console.error(`SDK generator drift in ${name}. Run node packages/sdk/scripts/generate.mjs.`);
      process.exitCode = 1;
    }
  }
}
