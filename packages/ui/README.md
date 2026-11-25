# Platform UI

Mount the package in a React application with a verified bearer token.

```tsx
import { HttpPlatformClient, PlatformApp } from '@bs/ui';

const client = new HttpPlatformClient({ baseUrl: '', token: fixtureToken });

<PlatformApp
  client={client}
  extraRoutes={[
    { path: '/bots', title: 'Bots', component: BotsScreen },
    { path: '/workflows', title: 'Workflows', component: WorkflowScreen },
    { path: '/bots/chat', title: 'Chat', component: ChatScreen },
    { path: '/bots/voice', title: 'Voice', component: VoiceScreen },
  ]}
/>;
```

Each injected component receives the scoped client, verified identity, workspace, current path, and notification callback. A route with the same path as a built-in route replaces it. Set `navLabel` to put a new path in the sidebar. Use links such as `#/bots/voice` to reach routes that sit below a sidebar entry.

When the mounting app can resolve a verified client for a different workspace, pass `resolveWorkspaceClient(workspace)`. The switcher lists only workspaces authorized by the current session. HTTP requests use the returned client's bearer token. With one workspace or without a resolver, the switcher shows the current workspace.

## Preview

Start the standalone preview from the repository root.

```sh
pnpm --filter @bs/ui dev
```

Open the local URL printed by Vite. The preview uses the fictional Rivetquay admin and resets on reload. Provider choices, region eligibility and secrets are fixture values.
