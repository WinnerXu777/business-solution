import { useCallback, useState } from 'react';
import type { Invitation, Member, NamedPermission, TeamRole } from '../clients/access.ts';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
} from '../components.tsx';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import type { ScreenProps } from './screen-helpers.tsx';

export function ConfirmChange({
  title,
  text,
  actionLabel,
  action,
  done,
  close,
  danger = false,
  ...props
}: ScreenProps & {
  title: string;
  text: string;
  actionLabel: string;
  action: () => Promise<unknown>;
  done: () => void;
  close: () => void;
  danger?: boolean;
}) {
  const { busy, run } = useAction(props.notify);
  return (
    <Dialog title={title} busy={busy} onClose={close}>
      <p>{text}</p>
      <div className="bs-actions bs-confirm">
        <Button variant="secondary" disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          disabled={busy}
          onClick={() => void run(action, done)}
        >
          {actionLabel}
        </Button>
      </div>
    </Dialog>
  );
}

function MemberForm({
  member,
  roles,
  onClose,
  reload,
  ...props
}: ScreenProps & { member?: Member; roles: TeamRole[]; onClose: () => void; reload: () => void }) {
  const { client, notify } = props;
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState(
    member?.roleId ?? roles.find((role) => role.id === 'reader')?.id ?? roles[0]?.id ?? '',
  );
  const [link, setLink] = useState<Invitation>();
  const { busy, run } = useAction(notify);

  return (
    <Dialog
      title={link ? 'Invitation link' : member ? 'Change member role' : 'Invite member'}
      busy={busy}
      onClose={onClose}
    >
      {link ? (
        <div className="bs-stack">
          <p>Copy this link now. It is shown only once.</p>
          <CodeBlock label="Invitation URL">{link.url}</CodeBlock>
          <p>
            Expires{' '}
            <time dateTime={link.expiresAt}>{new Date(link.expiresAt).toLocaleString()}</time>.
          </p>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <form
          className="bs-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (member)
              void run(
                () => client.access.changeRole(member.id, roleId),
                () => {
                  notify('Member role updated.');
                  onClose();
                  reload();
                },
              );
            else void run(() => client.access.invite({ email: email.trim(), roleId }), setLink);
          }}
        >
          {member ? (
            <p>{member.name}</p>
          ) : (
            <Field label="Email">
              {(attrs) => (
                <Input
                  {...attrs}
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </Field>
          )}
          <Field label="Role">
            {(attrs) => (
              <Select
                {...attrs}
                required
                value={roleId}
                onChange={(event) => setRoleId(event.target.value)}
              >
                {roles.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="bs-actions">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !roleId || roleId === member?.roleId}>
              {member ? 'Save role' : 'Create invitation'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function MembersScreen(props: ScreenProps) {
  const { client, me, notify } = props;
  const admin = me.role === 'admin';
  const resource = useResource(
    useCallback(async () => {
      const [members, roles] = await Promise.all([
        client.access.listMembers(),
        admin ? client.access.listRoles() : [],
      ]);
      return { members, roles };
    }, [client, admin]),
  );
  const [selection, setSelection] = useState<
    { kind: 'invite' } | { kind: 'role' | 'remove'; member: Member }
  >();
  const close = () => setSelection(undefined);
  return (
    <RemoteContent resource={resource} label="members">
      {({ members, roles }) => (
        <Card
          title="Workspace members"
          action={
            admin && (
              <Button disabled={!roles.length} onClick={() => setSelection({ kind: 'invite' })}>
                Invite member
              </Button>
            )
          }
        >
          <Table
            label="Workspace members"
            rows={members}
            rowKey={(row) => row.id}
            columns={[
              { key: 'name', title: 'Name', render: (row) => row.name },
              { key: 'email', title: 'Email', render: (row) => row.email },
              {
                key: 'role',
                title: 'Role',
                render: (row) => roles.find(({ id }) => id === row.roleId)?.name ?? row.roleId,
              },
              ...(admin
                ? [
                    {
                      key: 'actions',
                      title: 'Manage',
                      render: (member: Member) =>
                        member.id !== me.actor.id && (
                          <div className="bs-actions">
                            <Button
                              variant="secondary"
                              aria-label={'Change role for ' + member.name}
                              onClick={() => setSelection({ kind: 'role', member })}
                            >
                              Change role
                            </Button>
                            <Button
                              variant="secondary"
                              aria-label={'Remove ' + member.name}
                              onClick={() => setSelection({ kind: 'remove', member })}
                            >
                              Remove
                            </Button>
                          </div>
                        ),
                    },
                  ]
                : []),
            ]}
            empty="There are no workspace members."
          />
          {selection?.kind === 'remove' && (
            <ConfirmChange
              {...props}
              title="Remove member"
              text={selection.member.name + ' will lose workspace access.'}
              actionLabel="Confirm removal"
              danger
              close={close}
              action={() => client.access.removeMember(selection.member.id)}
              done={() => {
                close();
                resource.reload();
                notify('Member removed.');
              }}
            />
          )}
          {(selection?.kind === 'invite' || selection?.kind === 'role') && (
            <MemberForm
              {...props}
              roles={roles}
              member={selection.kind === 'role' ? selection.member : undefined}
              onClose={close}
              reload={resource.reload}
            />
          )}
        </Card>
      )}
    </RemoteContent>
  );
}

function RoleForm({
  role,
  permissions,
  close,
  done,
  ...props
}: ScreenProps & {
  role?: TeamRole;
  permissions: NamedPermission[];
  close: () => void;
  done: () => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? []);
  const { busy, run } = useAction(props.notify);
  return (
    <Dialog title={role ? 'Edit custom role' : 'Create custom role'} onClose={close} busy={busy}>
      <form
        className="bs-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () =>
              props.client.access.saveRole({ name: name.trim(), permissions: selected }, role?.id),
            done,
          );
        }}
      >
        <Field label="Role name">
          {(attrs) => (
            <Input
              {...attrs}
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <fieldset className="bs-option-list">
          <legend>Named permissions</legend>
          {permissions.map(({ id, label }) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, id]
                      : selected.filter((value) => value !== id),
                  )
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="bs-actions">
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || !selected.length}>
            Save custom role
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RolesScreen(props: ScreenProps) {
  if (props.me.role !== 'admin')
    return <EmptyState title="Workspace administrator access is required." />;
  return <RolesAdmin {...props} />;
}

function RolesAdmin(props: ScreenProps) {
  const { client, notify } = props;
  const resource = useResource(
    useCallback(async () => {
      const [roles, permissions] = await Promise.all([
        client.access.listRoles(),
        client.access.listPermissions(),
      ]);
      return { roles, permissions };
    }, [client]),
  );
  const [selection, setSelection] = useState<
    { kind: 'edit'; role?: TeamRole } | { kind: 'delete'; role: TeamRole }
  >();
  const close = () => setSelection(undefined);
  function done(message: string) {
    close();
    resource.reload();
    notify(message);
  }
  return (
    <RemoteContent resource={resource} label="roles">
      {({ roles, permissions }) => (
        <Card
          title="Workspace roles"
          action={
            <Button disabled={!permissions.length} onClick={() => setSelection({ kind: 'edit' })}>
              New custom role
            </Button>
          }
        >
          <Table
            label="Workspace roles"
            rows={roles}
            rowKey={(row) => row.id}
            empty="No workspace roles."
            columns={[
              { key: 'name', title: 'Role', render: (row) => row.name },
              {
                key: 'kind',
                title: 'Type',
                render: (row) => <Badge>{row.builtIn ? 'Built-in' : 'Custom'}</Badge>,
              },
              {
                key: 'permissions',
                title: 'Permissions',
                render: (row) =>
                  row.permissions
                    .map(
                      (id) => permissions.find((permission) => permission.id === id)?.label ?? id,
                    )
                    .join(', '),
              },
              {
                key: 'actions',
                title: 'Manage',
                render: (role) =>
                  !role.builtIn && (
                    <div className="bs-actions">
                      <Button
                        variant="secondary"
                        aria-label={'Edit ' + role.name}
                        onClick={() => setSelection({ kind: 'edit', role })}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="secondary"
                        aria-label={'Delete ' + role.name}
                        onClick={() => setSelection({ kind: 'delete', role })}
                      >
                        Delete
                      </Button>
                    </div>
                  ),
              },
            ]}
          />
          {selection?.kind === 'edit' && (
            <RoleForm
              {...props}
              role={selection.role}
              permissions={permissions}
              close={close}
              done={() => done('Custom role saved.')}
            />
          )}
          {selection?.kind === 'delete' && (
            <ConfirmChange
              {...props}
              title="Delete custom role"
              text={'Delete ' + selection.role.name + '?'}
              actionLabel="Confirm deletion"
              danger
              close={close}
              action={() => client.access.deleteRole(selection.role.id)}
              done={() => done('Custom role deleted.')}
            />
          )}
        </Card>
      )}
    </RemoteContent>
  );
}
