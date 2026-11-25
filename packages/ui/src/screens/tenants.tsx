import { useCallback, useEffect, useRef, useState } from 'react';
import type { Tenant, TenantOptions, TenantProvision } from '../clients/access.ts';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  StatusPill,
  Table,
} from '../components.tsx';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import { ConfirmChange } from './access.tsx';
import { Details, useRequestKey } from './feature-helpers.tsx';
import type { ScreenProps } from './screen-helpers.tsx';

function ProvisionForm({
  options,
  done,
  close,
  ...props
}: ScreenProps & {
  options: TenantOptions;
  done: () => void;
  close: () => void;
}) {
  const [step, setStep] = useState(0);
  const [input, setInput] = useState<TenantProvision>({
    name: '',
    region: options.regions[0]?.id ?? '',
    plan: options.plans[0]?.id ?? '',
    modules: options.modules.filter((module) => module.default).map(({ id }) => id),
    nativeBindings: options.nativeBindings
      .filter((binding) => binding.default)
      .map(({ capability, providerId }) => ({ capability, providerId })),
  });
  const focus = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    focus.current?.focus();
  }, [step]);
  const request = useRequestKey();
  const { busy, run } = useAction(props.notify);
  const capabilities = [...new Set(options.nativeBindings.map(({ capability }) => capability))];
  return (
    <Dialog title="Provision tenant" busy={busy} onClose={close}>
      <form
        className="bs-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (step < 2) {
            setStep(step + 1);
            return;
          }
          const tenant = { ...input, name: input.name.trim() };
          void run(() => props.client.access.provision(tenant, request.key(tenant)), done);
        }}
      >
        <h3 ref={focus} tabIndex={-1}>
          {['Tenant details', 'Modules and bindings', 'Review tenant'][step]}
        </h3>
        {step === 0 && (
          <>
            <Field label="Tenant name">
              {(attrs) => (
                <Input
                  {...attrs}
                  required
                  maxLength={100}
                  value={input.name}
                  onChange={(event) => setInput({ ...input, name: event.target.value })}
                />
              )}
            </Field>
            <Field label="Region">
              {(attrs) => (
                <Select
                  {...attrs}
                  value={input.region}
                  required
                  onChange={(event) => setInput({ ...input, region: event.target.value })}
                >
                  {options.regions.map(({ id, label }) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Plan">
              {(attrs) => (
                <Select
                  {...attrs}
                  value={input.plan}
                  required
                  onChange={(event) => setInput({ ...input, plan: event.target.value })}
                >
                  {options.plans.map(({ id, label }) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        )}
        {step === 1 && (
          <>
            <fieldset className="bs-option-list">
              <legend>Default modules</legend>
              {options.modules.map(({ id, label }) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={input.modules.includes(id)}
                    onChange={(event) =>
                      setInput({
                        ...input,
                        modules: event.target.checked
                          ? [...input.modules, id]
                          : input.modules.filter((item) => item !== id),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <fieldset className="bs-option-list">
              <legend>Native bindings</legend>
              {capabilities.map((capability) => (
                <Field key={capability} label={capability}>
                  {(attrs) => (
                    <Select
                      {...attrs}
                      value={
                        input.nativeBindings.find((binding) => binding.capability === capability)
                          ?.providerId ?? ''
                      }
                      onChange={(event) => {
                        const providerId = event.target.value;
                        const others = input.nativeBindings.filter(
                          (binding) => binding.capability !== capability,
                        );
                        setInput({
                          ...input,
                          nativeBindings: providerId
                            ? [...others, { capability, providerId }]
                            : others,
                        });
                      }}
                    >
                      <option value="">No binding</option>
                      {options.nativeBindings
                        .filter((binding) => binding.capability === capability)
                        .map(({ providerId, label }) => (
                          <option key={providerId} value={providerId}>
                            {label}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
              ))}
            </fieldset>
          </>
        )}
        {step === 2 && (
          <Details
            fields={[
              ['Tenant', input.name.trim()],
              ['Region', options.regions.find(({ id }) => id === input.region)?.label],
              ['Plan', options.plans.find(({ id }) => id === input.plan)?.label],
              [
                'Modules',
                options.modules
                  .filter(({ id }) => input.modules.includes(id))
                  .map(({ label }) => label)
                  .join(', ') || 'None',
              ],
              [
                'Bindings',
                input.nativeBindings
                  .map(({ capability, providerId }) => capability + ' / ' + providerId)
                  .join(', ') || 'None',
              ],
            ]}
          />
        )}
        <div className="bs-actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => (step ? setStep(step - 1) : close())}
          >
            {step ? 'Back' : 'Cancel'}
          </Button>
          <Button
            type="submit"
            disabled={busy || !input.name.trim() || !input.region || !input.plan}
          >
            {step === 2 ? 'Create tenant' : 'Continue'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function TenantsScreen(props: ScreenProps) {
  if (!props.me.platformOperator)
    return <EmptyState title="Platform operator access is required." />;
  return <TenantsAdmin {...props} />;
}

function TenantsAdmin(props: ScreenProps) {
  const { client, notify } = props;
  const resource = useResource(useCallback(() => client.access.listTenants(), [client]));
  const [selection, setSelection] = useState<
    { kind: 'provision' } | { kind: 'status'; tenant: Tenant }
  >();
  const close = () => setSelection(undefined);
  const status =
    selection?.kind === 'status' && selection.tenant.status === 'active' ? 'suspended' : 'active';
  const verb = status === 'suspended' ? 'Suspend' : 'Resume';
  function done(message: string) {
    close();
    resource.reload();
    notify(message);
  }
  return (
    <Card
      title="Platform tenants"
      action={<Button onClick={() => setSelection({ kind: 'provision' })}>Provision tenant</Button>}
    >
      <RemoteContent resource={resource} label="tenants">
        {(tenants) => (
          <Table
            label="Tenants"
            rows={tenants}
            rowKey={(row) => row.id}
            empty="No tenants have been provisioned."
            columns={[
              { key: 'name', title: 'Name', render: (row) => row.name },
              { key: 'region', title: 'Region', render: (row) => row.region },
              { key: 'plan', title: 'Plan', render: (row) => row.plan },
              {
                key: 'status',
                title: 'Status',
                render: (row) => <StatusPill status={row.status} />,
              },
              {
                key: 'actions',
                title: 'Manage',
                render: (tenant) => (
                  <Button
                    variant="secondary"
                    aria-label={(tenant.status === 'active' ? 'Suspend ' : 'Resume ') + tenant.name}
                    onClick={() => setSelection({ kind: 'status', tenant })}
                  >
                    {tenant.status === 'active' ? 'Suspend' : 'Resume'}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </RemoteContent>
      {selection?.kind === 'provision' && (
        <ProvisionOptions {...props} close={close} done={() => done('Tenant provisioned.')} />
      )}
      {selection?.kind === 'status' && (
        <ConfirmChange
          {...props}
          title={verb + ' tenant'}
          text={verb + ' ' + selection.tenant.name + '?'}
          actionLabel={'Confirm ' + verb.toLowerCase()}
          danger={status === 'suspended'}
          close={close}
          action={() => client.access.setTenantStatus(selection.tenant.id, status)}
          done={() => done(status === 'suspended' ? 'Tenant suspended.' : 'Tenant resumed.')}
        />
      )}
    </Card>
  );
}

function ProvisionOptions(props: ScreenProps & { close: () => void; done: () => void }) {
  const resource = useResource(
    useCallback(() => props.client.access.tenantOptions(), [props.client]),
  );
  if (resource.state.status !== 'ready')
    return (
      <Dialog title="Provision tenant" onClose={props.close}>
        <RemoteContent resource={resource} label="provisioning options">
          {() => null}
        </RemoteContent>
      </Dialog>
    );
  return <ProvisionForm {...props} options={resource.state.data} />;
}
