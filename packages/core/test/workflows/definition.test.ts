import assert from 'node:assert/strict';
import test from 'node:test';
import {
  connectorKey,
  diffVersions,
  validateGraph,
  type WorkflowDefinition,
} from '../../src/workflows/definition.ts';
import { instantiateTemplate, listTemplates } from '../../src/workflows/templates.ts';

test('all ten templates instantiate valid typed graphs with independent synthetic fixtures', () => {
  const library = listTemplates();
  assert.equal(library.length, 10);
  for (const template of library) {
    const installed = instantiateTemplate(template.id, {})!;
    assert.deepEqual(installed.fixture, template.fixture);
    assert.deepEqual(installed.trigger, template.trigger);
    validateGraph(installed.definition, new Set());
  }
  const configured = instantiateTemplate('win-back', { days: 120, message: 'Fictional offer' })!;
  assert.equal(configured.trigger.kind === 'event' && configured.trigger.threshold, 120);
  assert.throws(() => instantiateTemplate('win-back', { days: 0 }));
  assert.throws(() => instantiateTemplate('reorder-alert', { dueDays: 8 }));
  assert.throws(() => instantiateTemplate('quote-follow-up', { extra: true }));
});

const base: WorkflowDefinition = {
  id: 'advanced',
  version: 1,
  inputs: { list: 'string-list', key: 'string' },
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual', next: 'loop' },
    {
      id: 'loop',
      kind: 'loop',
      items: { ref: 'list' },
      item: 'item',
      maxItems: 2,
      body: 'lookup',
      next: 'wait',
    },
    {
      id: 'lookup',
      kind: 'http',
      connector: 'fixture',
      operation: 'lookup',
      recordId: { ref: 'item' },
      output: 'lookupId',
      next: 'end',
    },
    { id: 'end', kind: 'loop-end', loop: 'loop' },
    {
      id: 'wait',
      kind: 'wait-for-event',
      event: 'approval.decided',
      key: { ref: 'key' },
      timeoutMs: 100,
      next: null,
      onTimeout: null,
    },
  ],
};

test('graph rejects missing output across loop boundary, unreachable nodes and unbounded cycles', () => {
  const allowed = new Set([connectorKey('fixture', 'lookup')]);
  validateGraph(base, allowed);
  assert.throws(() => validateGraph(base, new Set()), /allowlisted/);
  const leak = structuredClone(base);
  const wait = leak.nodes[4];
  assert.equal(wait.kind, 'wait-for-event');
  if (wait.kind === 'wait-for-event') wait.key = { ref: 'lookupId' };
  assert.throws(() => validateGraph(leak, allowed), /input type/);
  const cycle = structuredClone(base);
  if (cycle.nodes[4].kind === 'wait-for-event') cycle.nodes[4].onTimeout = 'start';
  assert.throws(() => validateGraph(cycle, allowed), /Cycle/);
  assert.throws(
    () =>
      validateGraph(
        { ...base, nodes: [...base.nodes, { id: 'orphan', kind: 'checkpoint', next: null }] },
        allowed,
      ),
    /Unreachable/,
  );
});

test('version diff is order independent and includes node-level changes', () => {
  const revised: WorkflowDefinition = {
    ...base,
    version: 2,
    inputs: { key: 'string', list: 'string-list' },
    nodes: [
      ...base.nodes.slice(0, 4).reverse(),
      { id: 'wait', kind: 'delay', milliseconds: 10, next: 'finish' },
      { id: 'finish', kind: 'checkpoint', next: null },
    ],
  };
  assert.deepEqual(diffVersions(base, revised), {
    from: 1,
    to: 2,
    added: ['finish'],
    removed: [],
    changed: ['wait'],
    inputsChanged: false,
  });
});
