import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { Portal } from './portal.tsx';

const root = document.querySelector('#root');
if (!root) throw new Error('Missing portal root');

createRoot(root).render(<Portal />);
