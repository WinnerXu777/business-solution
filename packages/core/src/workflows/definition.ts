export type Scalar = string | number | boolean | null;
export type Value = Scalar | string[] | { ref: string };
export type ValueType = 'string' | 'integer' | 'boolean' | 'null' | 'string-list' | 'draft';
export type Values = Record<string, Scalar | string[]>;
export type TriggerKind = 'manual' | 'schedule' | 'event' | 'webhook';

type Edge = string | null;
type NodeBase = { id: string; kind: string };
type Next = { next: Edge };
export type WorkflowNode = NodeBase &
  (
    | { kind: 'trigger'; trigger: TriggerKind; next: string }
    | ({ kind: 'mapping'; values: Record<string, Value> } & Next)
    | ({ kind: 'branch'; left: Value; equals: Scalar; otherwise: Edge } & Next)
    | { kind: 'switch'; value: Value; cases: { equals: Scalar; next: Edge }[]; otherwise: Edge }
    | ({ kind: 'loop'; items: Value; item: string; maxItems: number; body: string } & Next)
    | { kind: 'loop-end'; loop: string }
    | ({ kind: 'delay'; milliseconds: number } & Next)
    | ({ kind: 'checkpoint' } & Next)
    | ({
        kind: 'wait-for-event';
        event: string;
        key: Value;
        timeoutMs: number;
        onTimeout: Edge;
      } & Next)
    | ({ kind: 'ab-split'; key: Value; aPercent: number; otherwise: Edge } & Next)
    | ({ kind: 'throttle'; bucket: string; limit: number; windowMs: number } & Next)
    | ({ kind: 'human-task'; role: string; title: Value; dueMs: number; onTimeout: Edge } & Next)
    | ({ kind: 'llm-draft'; model: string; prompt: Value; output: string } & Next)
    | ({
        kind: 'message';
        channel: 'email' | 'sms' | 'voice';
        purpose: 'marketing' | 'transactional' | 'collections';
        recipientId: Value;
        sourceId: Value;
        body?: Value;
      } & Next)
    | ({
        kind: 'create-record';
        recordType: string;
        subjectId: Value;
        summary: Value;
        output: string;
      } & Next)
    | ({
        kind: 'update-record';
        recordType: string;
        recordId: Value;
        summary: Value;
        output: string;
      } & Next)
    | ({
        kind: 'http';
        connector: string;
        operation: string;
        recordId: Value;
        output: string;
      } & Next)
  );

export type WorkflowDefinition = {
  id: string;
  version: number;
  inputs: Record<string, ValueType>;
  nodes: WorkflowNode[];
};

export const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const connectorKey = (connector: string, operation: string) =>
  JSON.stringify([connector, operation]);

export function valueType(value: Scalar | string[]): ValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'string-list';
  if (typeof value === 'number') return 'integer';
  return typeof value === 'string' ? 'string' : 'boolean';
}

export function edges(node: WorkflowNode): Edge[] {
  switch (node.kind) {
    case 'loop-end':
      return [];
    case 'loop':
      return [node.body, node.next];
    case 'switch':
      return [...node.cases.map(({ next }) => next), node.otherwise];
    case 'branch':
    case 'ab-split':
      return [node.next, node.otherwise];
    case 'wait-for-event':
    case 'human-task':
      return [node.next, node.onTimeout];
    default:
      return [node.next];
  }
}

// Run after structural validation. Intersect available fields at joins.
export function validateGraph(definition: WorkflowDefinition, connectors: ReadonlySet<string>) {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const root = definition.nodes[0];
  if (nodes.size !== definition.nodes.length || root?.kind !== 'trigger')
    throw new Error('Expected an initial trigger and unique node IDs');
  if (Object.values(definition.inputs).includes('draft'))
    throw new Error('Only the drafting node can produce draft values');
  const order: WorkflowNode[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error('Cycle outside a bounded loop');
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error('Unknown node ' + id);
    visiting.add(id);
    for (const target of edges(node)) if (target !== null) visit(target);
    visiting.delete(id);
    visited.add(id);
    order.push(node);
  }
  visit(root.id);
  if (visited.size !== nodes.size) throw new Error('Unreachable node');
  const incoming = new Map<string, { fields: Map<string, ValueType>; loop?: string }>();
  incoming.set(root.id, { fields: new Map(Object.entries(definition.inputs)) });
  const loops = new Set<string>();
  for (const node of order.reverse()) {
    const { fields, loop } = incoming.get(node.id)!;
    const output = new Map(fields);
    function requireType(value: Value, ...types: ValueType[]) {
      const actual =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? fields.get(value.ref)
          : valueType(value);
      if (!actual || (types.length && !types.includes(actual)))
        throw new Error('Invalid input type or unavailable field at ' + node.id);
      return actual;
    }
    switch (node.kind) {
      case 'trigger':
        if (node !== root) throw new Error('Only the first node can be a trigger');
        break;
      case 'mapping':
        for (const [name, value] of Object.entries(node.values))
          output.set(name, requireType(value));
        break;
      case 'branch':
        requireType(node.left, valueType(node.equals));
        break;
      case 'switch':
        if (new Set(node.cases.map(({ equals }) => equals)).size !== node.cases.length)
          throw new Error('Duplicate switch case');
        for (const branch of node.cases) requireType(node.value, valueType(branch.equals));
        break;
      case 'loop':
        if (loop) throw new Error('Nested loops are unsupported');
        requireType(node.items, 'string-list');
        break;
      case 'loop-end':
        if (node.loop !== loop) throw new Error('Loop end has no matching loop');
        loops.add(node.loop);
        break;
      case 'checkpoint':
        if (loop) throw new Error('Checkpoint inside loop');
        break;
      case 'wait-for-event':
      case 'ab-split':
        requireType(node.key, 'string');
        break;
      case 'human-task':
        requireType(node.title, 'string');
        break;
      case 'llm-draft':
        requireType(node.prompt, 'string');
        output.set(node.output, 'draft');
        break;
      case 'message':
        requireType(node.recipientId, 'string');
        requireType(node.sourceId, 'string');
        if (node.body !== undefined) requireType(node.body, 'string', 'draft');
        break;
      case 'create-record':
      case 'update-record':
      case 'http':
        if (node.kind === 'http') {
          if (!connectors.has(connectorKey(node.connector, node.operation)))
            throw new Error('Connector operation is not allowlisted');
        } else {
          requireType(node.summary, 'string');
        }
        requireType(node.kind === 'create-record' ? node.subjectId : node.recordId, 'string');
        output.set(node.output, 'string');
        break;
    }
    for (const target of edges(node)) {
      if (target === null) {
        if (loop) throw new Error('Loop path must finish at a loop end');
        continue;
      }
      const inBody = node.kind === 'loop' && target === node.body;
      if (inBody && node.next === target) throw new Error('Loop body and exit must differ');
      const owner = inBody ? node.id : loop;
      const available = new Map(output);
      if (inBody) available.set(node.item, 'string');
      const prior = incoming.get(target);
      if (!prior) incoming.set(target, { fields: available, loop: owner });
      else {
        if (prior.loop !== owner) throw new Error('Loop body crosses graph boundary');
        for (const [name, type] of prior.fields)
          if (available.get(name) !== type) prior.fields.delete(name);
      }
    }
  }
  if (definition.nodes.some((node) => node.kind === 'loop' && !loops.has(node.id)))
    throw new Error('Missing loop end');
}

export function diffVersions(from: WorkflowDefinition, to: WorkflowDefinition) {
  const before = new Map(from.nodes.map((node) => [node.id, node]));
  const after = new Map(to.nodes.map((node) => [node.id, node]));
  return {
    from: from.version,
    to: to.version,
    added: [...after.keys()].filter((id) => !before.has(id)).sort(),
    removed: [...before.keys()].filter((id) => !after.has(id)).sort(),
    changed: [...after.keys()]
      .filter(
        (id) => before.has(id) && canonicalJson(before.get(id)) !== canonicalJson(after.get(id)),
      )
      .sort(),
    inputsChanged: canonicalJson(from.inputs) !== canonicalJson(to.inputs),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  });
}
