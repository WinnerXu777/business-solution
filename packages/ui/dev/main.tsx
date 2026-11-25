import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthenticatedPlatformApp, MockAuthClient, MockPlatformClient } from '../src/index.ts';

const root = createRoot(document.getElementById('root')!);
const client = new MockPlatformClient({ auth: new MockAuthClient(), platformOperator: true });
let revision = 0;

function render() {
  root.render(
    <StrictMode>
      <AuthenticatedPlatformApp
        key={revision}
        client={client}
        navigate={(url) => {
          window.history.replaceState(null, '', url);
          revision++;
          render();
        }}
      />
    </StrictMode>,
  );
}

render();
