import { createRequire } from 'node:module';
import type {
  ChatInput,
  EmbeddingInput,
  JsonObject,
} from '../../../../packages/adapters/src/llm/index.ts';

type Check = (value: unknown) => boolean;
type Validator = { compile(schema: JsonObject): Check; removeSchema(schema: JsonObject): void };
type ValidatorClass = new (options: JsonObject) => Validator;

// Resolve the AJV version already installed by Fastify's schema compiler.
const fromFastify = createRequire(import.meta.resolve('fastify'));
const fromCompiler = createRequire(fromFastify.resolve('@fastify/ajv-compiler'));
const Ajv = fromCompiler('ajv/dist/2020.js') as ValidatorClass;
const ajv = new Ajv({ addUsedSchema: false, ownProperties: true, strict: false });

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const badInput = () => new ApiError(400, 'invalid_request');
const name = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' };
const model = { type: 'string', minLength: 1, maxLength: 128 };
const content = { type: 'string' };
const flag = { type: 'boolean' };
const record = { type: 'object' };
const limit = { type: 'integer', minimum: 1, maximum: 8192 };
const id = { type: 'string', minLength: 1, maxLength: 256 };
const fn = { const: 'function' };
const shape = (properties: JsonObject, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const array = (items: JsonObject, maxItems: number, minItems = 1) => ({
  type: 'array',
  items,
  maxItems,
  minItems,
});

const call = shape({
  id,
  type: fn,
  function: shape({ name, arguments: content }),
});
const chatCheck = ajv.compile(
  shape(
    {
      model,
      messages: array(
        {
          oneOf: [
            shape({ role: { enum: ['system', 'developer', 'user'] }, content }),
            shape(
              {
                role: { const: 'assistant' },
                content: { type: ['string', 'null'] },
                tool_calls: array(call, 32),
              },
              ['role'],
            ),
            shape({ role: { const: 'tool' }, content, tool_call_id: id }),
          ],
        },
        128,
      ),
      max_completion_tokens: limit,
      max_tokens: limit,
      stream: flag,
      stream_options: shape({ include_usage: flag }, []),
      n: { const: 1 },
      temperature: { type: 'number', minimum: 0, maximum: 2 },
      tools: array(
        shape({
          type: fn,
          function: shape({ name, description: content, parameters: record, strict: flag }, [
            'name',
          ]),
        }),
        32,
      ),
      tool_choice: {
        oneOf: [
          { enum: ['none', 'auto', 'required'] },
          shape({ type: fn, function: shape({ name }) }),
        ],
      },
      response_format: {
        oneOf: [
          shape({ type: { const: 'text' } }),
          shape({
            type: { const: 'json_schema' },
            json_schema: shape({ name, schema: record, strict: flag }, ['name', 'schema']),
          }),
        ],
      },
    },
    ['model', 'messages'],
  ),
);

const embedCheck = ajv.compile(
  shape(
    {
      model,
      input: { oneOf: [content, array(content, 128)] },
      dimensions: { type: 'integer', minimum: 1, maximum: 4096 },
      encoding_format: { enum: ['float', 'base64'] },
    },
    ['model', 'input'],
  ),
);

type ChatBody = Omit<ChatInput, 'max_completion_tokens'> & {
  max_completion_tokens?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  n?: 1;
};

export function readChat(value: unknown) {
  if (!chatCheck(value)) throw badInput();
  const {
    stream = false,
    stream_options,
    n: _n,
    max_tokens,
    max_completion_tokens,
    messages,
    ...input
  } = value as ChatBody;
  if (max_tokens !== undefined && max_completion_tokens !== undefined) throw badInput();
  if (stream_options && !stream) throw badInput();
  const toolNames = new Set(input.tools?.map((tool) => tool.function.name));
  if (toolNames.size !== (input.tools?.length ?? 0)) throw badInput();
  if (input.tool_choice === 'required' && !toolNames.size) throw badInput();
  if (typeof input.tool_choice === 'object' && !toolNames.has(input.tool_choice.function.name)) {
    throw badInput();
  }
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (message.content == null && !message.tool_calls?.length) throw badInput();
    for (const call of message.tool_calls ?? []) {
      try {
        if (!isObject(JSON.parse(call.function.arguments))) throw badInput();
      } catch {
        throw badInput();
      }
    }
  }
  return {
    stream,
    includeUsage: stream_options?.include_usage === true,
    input: {
      ...input,
      messages: messages.map((message) =>
        message.role === 'assistant' ? { ...message, content: message.content ?? null } : message,
      ),
      max_completion_tokens: max_completion_tokens ?? max_tokens ?? 256,
    } satisfies ChatInput,
  };
}

export function readEmbeddings(value: unknown) {
  if (!embedCheck(value)) throw badInput();
  const { encoding_format, ...input } = value as EmbeddingInput & {
    encoding_format?: 'float' | 'base64';
  };
  return { input, encoding: encoding_format ?? 'float' };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const annotations = new Set(['title', 'description', 'default', 'examples']);
const values = new Set([
  'type',
  'enum',
  'const',
  'required',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
]);

// Bound the expanded validation program for tenant-supplied schemas.
function checkSchema(root: JsonObject) {
  let remaining = 512;
  function visit(schema: unknown, depth: number): void {
    if (--remaining < 0 || depth > 24) throw badInput();
    if (typeof schema === 'boolean') return;
    if (!isObject(schema)) throw badInput();
    for (const [key, value] of Object.entries(schema)) {
      if (annotations.has(key) || values.has(key)) continue;
      switch (key) {
        case 'properties':
        case '$defs':
          if (!isObject(value)) throw badInput();
          for (const child of Object.values(value)) visit(child, depth + 1);
          break;
        case 'anyOf':
        case 'oneOf':
        case 'allOf':
          if (!Array.isArray(value)) throw badInput();
          for (const child of value) visit(child, depth + 1);
          break;
        case 'items':
        case 'additionalProperties':
          visit(value, depth + 1);
          break;
        case '$ref': {
          if (typeof value !== 'string') throw badInput();
          const ref = /^#\/\$defs\/([a-zA-Z0-9_-]+)$/.exec(value)?.[1];
          const defs = root.$defs;
          if (!ref || !isObject(defs) || !Object.hasOwn(defs, ref)) throw badInput();
          visit(defs[ref], depth + 1);
          break;
        }
        default:
          throw badInput();
      }
    }
  }
  visit(root, 0);
}

export function structuredOutput(input: ChatInput): ((content: string | null) => void) | undefined {
  if (input.response_format?.type !== 'json_schema') return;
  const schema = input.response_format.json_schema.schema;
  let check: Check;
  try {
    checkSchema(schema);
    try {
      check = ajv.compile(schema);
    } finally {
      ajv.removeSchema(schema);
    }
  } catch {
    throw new ApiError(400, 'invalid_json_schema');
  }
  return (content) => {
    try {
      if (content === null || !check(JSON.parse(content))) throw new Error();
    } catch {
      throw new ApiError(502, 'invalid_structured_output');
    }
  };
}
