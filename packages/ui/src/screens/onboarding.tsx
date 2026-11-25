import { useCallback } from 'react';
import type { SetupStep } from '../clients/access.ts';
import { Badge, Card } from '../components.tsx';
import { RemoteContent, useResource } from '../data.tsx';
import type { PlatformClient } from '../platform-client.ts';

const steps: { id: SetupStep; label: string; href: string }[] = [
  {
    id: 'import_records',
    label: 'Import records',
    href: '#/connectors/connector/inventory-fixture',
  },
  { id: 'connect_accounting', label: 'Connect accounting', href: '#/connectors' },
  { id: 'choose_providers', label: 'Choose providers', href: '#/providers' },
  { id: 'invite_team', label: 'Invite team', href: '#/members' },
  { id: 'publish_workflow', label: 'Publish first workflow', href: '#/workflows' },
];

export function SetupChecklist({ client }: { client: PlatformClient }) {
  const progress = useResource(useCallback(() => client.access.setupProgress(), [client]));
  return (
    <Card title="First-run setup">
      <RemoteContent resource={progress} label="setup progress">
        {({ completed }) => {
          const count = steps.filter(({ id }) => completed.includes(id)).length;
          return (
            <>
              <p>
                {count} of {steps.length} steps complete
              </p>
              <progress aria-label="Workspace setup progress" max={steps.length} value={count} />
              <ul className="bs-setup-list">
                {steps.map(({ id, label, href }) => (
                  <li key={id}>
                    <a href={href}>{label}</a>
                    <Badge tone={completed.includes(id) ? 'success' : 'neutral'}>
                      {completed.includes(id) ? 'Complete' : 'To do'}
                    </Badge>
                  </li>
                ))}
              </ul>
            </>
          );
        }}
      </RemoteContent>
    </Card>
  );
}
