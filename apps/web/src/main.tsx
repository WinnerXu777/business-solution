import { createRoot } from 'react-dom/client';
import { ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const root = document.querySelector('#root');
if (!root) throw new Error('Missing portal root');

createRoot(root).render(
  <main>
    <h1>Rivetquay Industrial Supply</h1>
    <section aria-label="Workflow editor placeholder" style={{ height: 400 }}>
      <ReactFlow nodes={[]} edges={[]} />
    </section>
  </main>,
);
