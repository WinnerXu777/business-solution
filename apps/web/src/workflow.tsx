import { useState } from 'react';
import {
  Background,
  Controls,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
} from '@xyflow/react';
import { api, type WorkflowRun } from './api.ts';
import { MessageCard, Notice, Panel, useTask } from './panels.tsx';
import { resultText } from './presentation.ts';

const steps = [
  {
    id: 'trigger',
    label: 'Manual trigger',
    description: 'Start a preview or request a run from this screen.',
  },
  {
    id: 'filter',
    label: 'Filter customers',
    description:
      'Select customers whose last order was before June 1, 2026 and whose outreach is allowed.',
  },
  {
    id: 'approval',
    label: 'Require approval',
    description: 'Review the fixture recipients and message before signing the run.',
  },
  {
    id: 'send',
    label: 'Send win-back email',
    description:
      'Send the approved message to each eligible fixture customer and record its receipt.',
  },
];
const layout: Node[] = steps.map(({ id, label }, index) => ({
  id,
  data: { label },
  position: { x: index * 195, y: 0 },
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  type: index === 0 ? 'input' : index === steps.length - 1 ? 'output' : 'default',
}));
const edges: Edge[] = steps.slice(1).map(({ id }, index) => ({
  id: 'to-' + id,
  source: steps[index].id,
  target: id,
}));

export function Workflow({ history, onChange }: { history: WorkflowRun[]; onChange: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(layout);
  const [selected, select] = useState(steps[0]);
  const task = useTask();

  function run(mode: WorkflowRun['mode']) {
    void task.run(async () => {
      task.setNotice(resultText(await api.workflow(mode)));
      onChange();
    });
  }

  return (
    <div className="stack">
      <Panel title="Win-back workflow" aside={<span className="pill">win-back-v1</span>}>
        <div className="flow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onNodeClick={(_event, node) =>
              select(steps.find(({ id }) => id === node.id) ?? steps[0])
            }
            nodesConnectable={false}
            deleteKeyCode={null}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} color="#c9d2d5" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <div className="flow-detail">
          <label>
            Inspect step
            <select
              value={selected.id}
              onChange={(event) =>
                select(steps.find(({ id }) => id === event.target.value) ?? steps[0])
              }
            >
              {steps.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p>{selected.description}</p>
        </div>
        <div className="actions">
          <button disabled={task.busy} onClick={() => run('preview')}>
            Preview audience
          </button>
          <button className="secondary" disabled={task.busy} onClick={() => run('run')}>
            Request run
          </button>
          <button
            className="plain"
            onClick={() => {
              setNodes(layout);
              select(steps[0]);
            }}
          >
            Reset layout
          </button>
        </div>
        <Notice>{task.notice}</Notice>
        {history
          .find((entry) => entry.mode === 'preview')
          ?.previews.map((preview) => (
            <MessageCard key={preview.id} preview={preview} />
          ))}
      </Panel>
      <Panel title="Run history">
        {history.length === 0 ? (
          <p className="quiet">Previews and approval requests will appear here.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Mode</th>
                  <th scope="col">Status</th>
                  <th scope="col">Customers</th>
                  <th scope="col">Receipts</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td className="capitalize">{entry.mode}</td>
                    <td>{entry.status.replaceAll('_', ' ')}</td>
                    <td>
                      {entry.previews.map(({ customerId }) => customerId).join(', ') || 'None'}
                    </td>
                    <td>{entry.receipts.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
