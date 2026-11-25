import { PlatformError } from '../platform-client.ts';

export type Scalar = string | number | boolean | null;
export type WorkflowValue = Scalar | { ref: string };
export type TriggerKind = 'manual' | 'event' | 'schedule';
export type WorkflowAction =
  | { tool: 'order.read'; orderId: string | { ref: string } }
  | { tool: 'workflow.template.run'; templateId: 'win-back-v1' };

export type WorkflowNode = { id: string } & (
  | { kind: 'trigger'; trigger: TriggerKind; name?: string | null; next: string }
  | {
      kind: 'condition';
      left: WorkflowValue;
      equals: Scalar;
      next: string;
      otherwise: string | null;
    }
  | { kind: 'mapping'; values: Record<string, WorkflowValue>; next: string }
  | { kind: 'delay'; milliseconds: number; next: string }
  | { kind: 'approval'; next: string }
  | {
      kind: 'action';
      action: WorkflowAction;
      next?: string | null;
      maxAttempts?: number;
      backoffMs?: number;
    }
);

export interface WorkflowDefinition {
  id: string;
  version: number;
  nodes: WorkflowNode[];
}
export interface WorkflowTarget {
  definitionId: string;
  version: number;
  input: {
    trigger: { kind: TriggerKind; name?: string; key?: string };
    values: Record<string, Scalar>;
  };
}
export interface WorkflowStep {
  nodeId: string;
  kind: WorkflowNode['kind'];
  tool?: WorkflowAction['tool'];
  input?: unknown;
  milliseconds?: number;
}

export const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id);
export const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === 'boolean' ||
  Number.isSafeInteger(value) ||
  (typeof value === 'string' && value.length <= 1000);
const isReference = (value: unknown): value is { ref: string } =>
  typeof value === 'object' &&
  value !== null &&
  'ref' in value &&
  Object.keys(value).length === 1 &&
  validId(value.ref);
const isValue = (value: unknown): value is WorkflowValue => isScalar(value) || isReference(value);
const bounded = (value: number, max: number) =>
  Number.isInteger(value) && value >= 1 && value <= max;
export const isValueMap = <T>(
  value: unknown,
  check: (entry: unknown) => entry is T,
): value is Record<string, T> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length <= 32 &&
  Object.entries(value).every(([key, entry]) => validId(key) && check(entry));
export const isWorkflowMap = (value: unknown) => isValueMap(value, isValue);

export function workflowEdges(node: WorkflowNode) {
  return [
    { slot: 'next' as const, target: node.next },
    ...(node.kind === 'condition' ? [{ slot: 'otherwise' as const, target: node.otherwise }] : []),
  ].filter((edge): edge is { slot: 'next' | 'otherwise'; target: string } => !!edge.target);
}

const isDispatch = (node: WorkflowNode) =>
  node.kind === 'action' && node.action.tool === 'workflow.template.run';

export function validateWorkflow({ id, version, nodes }: WorkflowDefinition): string | undefined {
  if (!validId(id) || !bounded(version, 2_147_483_647))
    return 'Enter a valid definition ID and version.';
  if (nodes.length < 2 || nodes.length > 40) return 'Add between 2 and 40 nodes.';
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length || !nodes.every((node) => validId(node.id)))
    return 'Use unique, valid node IDs.';
  if (nodes[0].kind !== 'trigger' || nodes.slice(1).some((node) => node.kind === 'trigger'))
    return 'Start with one trigger.';

  for (const node of nodes) {
    if (node.kind !== 'action' && !node.next) return 'Connect the next step for ' + node.id + '.';
    if (workflowEdges(node).some(({ target }) => !byId.has(target)))
      return 'Connect to an existing node.';
    switch (node.kind) {
      case 'trigger':
        if (node.trigger === 'manual' ? !!node.name : !validId(node.name))
          return 'Event and schedule triggers require a valid name.';
        break;
      case 'condition':
        if (!isValue(node.left) || !isScalar(node.equals))
          return 'Enter a valid comparison for ' + node.id + '.';
        break;
      case 'mapping':
        if (!isWorkflowMap(node.values)) return 'Enter up to 32 valid mappings.';
        break;
      case 'delay':
        if (!bounded(node.milliseconds, 604_800_000))
          return 'Set the delay between 1 ms and 7 days.';
        break;
      case 'approval':
        if (!isDispatch(byId.get(node.next)!))
          return 'Connect approval directly to a dispatch action.';
        break;
      case 'action':
        if (
          node.action.tool === 'order.read' &&
          !validId(node.action.orderId) &&
          !isReference(node.action.orderId)
        )
          return 'Enter an order ID or reference.';
        if (!bounded(node.maxAttempts ?? 3, 5) || !bounded(node.backoffMs ?? 1000, 60_000))
          return 'Enter valid retry limits.';
        if (isDispatch(node)) {
          const incoming = nodes.filter((candidate) =>
            workflowEdges(candidate).some(({ target }) => target === node.id),
          );
          if (incoming.length !== 1 || incoming[0].kind !== 'approval')
            return 'Give dispatch exactly one incoming approval.';
        }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function acyclic(nodeId: string): boolean {
    if (visiting.has(nodeId)) return false;
    if (visited.has(nodeId)) return true;
    visiting.add(nodeId);
    if (!workflowEdges(byId.get(nodeId)!).every(({ target }) => acyclic(target))) return false;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return true;
  }
  if (!acyclic(nodes[0].id)) return 'Remove the cycle from the workflow.';
  if (visited.size !== nodes.length) return 'Connect every node to the trigger.';
}

export function resolveWorkflow(
  definition: WorkflowDefinition,
  input: WorkflowTarget['input'],
): WorkflowStep[] {
  if (validateWorkflow(definition)) throw new PlatformError('invalid_input');
  const trigger = definition.nodes[0];
  if (
    trigger.kind !== 'trigger' ||
    trigger.trigger !== input.trigger.kind ||
    (trigger.name ?? undefined) !== input.trigger.name ||
    (trigger.trigger !== 'manual' && !validId(input.trigger.key))
  ) {
    throw new PlatformError('invalid_input');
  }
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  let values = input.values;
  const resolve = (value: WorkflowValue) => {
    if (!isReference(value)) return value;
    if (!Object.hasOwn(values, value.ref)) throw new PlatformError('invalid_input');
    return values[value.ref];
  };
  const steps: WorkflowStep[] = [];
  let node: WorkflowNode | undefined = trigger;
  while (node) {
    const step: WorkflowStep = { nodeId: node.id, kind: node.kind };
    steps.push(step);
    let next: string | null | undefined = node.next;
    switch (node.kind) {
      case 'mapping':
        values = {
          ...values,
          ...Object.fromEntries(
            Object.entries(node.values).map(([key, value]) => [key, resolve(value)]),
          ),
        };
        break;
      case 'condition':
        if (resolve(node.left) !== node.equals) next = node.otherwise;
        break;
      case 'delay':
        step.milliseconds = node.milliseconds;
        break;
      case 'action':
        step.tool = node.action.tool;
        if (node.action.tool === 'order.read') {
          const orderId = resolve(node.action.orderId);
          if (!validId(orderId)) throw new PlatformError('invalid_input');
          step.input = { orderId };
        } else {
          step.input = { templateId: node.action.templateId, mode: 'run', approvalId: null };
        }
        break;
    }
    node = next ? byId.get(next) : undefined;
  }
  return steps;
}

export const winBackWorkflow: WorkflowDefinition = {
  id: 'win-back-v1',
  version: 1,
  nodes: [
    { id: 'manual', kind: 'trigger', trigger: 'manual', next: 'approve' },
    { id: 'approve', kind: 'approval', next: 'send' },
    {
      id: 'send',
      kind: 'action',
      action: { tool: 'workflow.template.run', templateId: 'win-back-v1' },
    },
  ],
};
