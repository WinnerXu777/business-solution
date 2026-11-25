import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MockPlatformClient, PlatformApp } from '../src/index.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PlatformApp client={new MockPlatformClient()} />
  </StrictMode>,
);
