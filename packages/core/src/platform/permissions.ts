export const permissions = [
  'platform.read',
  'records.read',
  'actions.request',
  'approvals.decide',
  'members.read',
  'roles.read',
  'members.manage',
  'roles.manage',
  'settings.manage',
  'exports.request',
] as const;

export type Permission = (typeof permissions)[number];

export interface RoleDefinition {
  id: string;
  name: string;
  permissions: readonly Permission[];
  builtIn: boolean;
}

const read = ['platform.read', 'records.read', 'members.read', 'roles.read'] as const;
const builtIns = {
  reader: read,
  operator: [...read, 'actions.request'],
  approver: [...read, 'approvals.decide'],
  admin: [...read, 'members.manage', 'roles.manage', 'settings.manage', 'exports.request'],
} satisfies Record<string, readonly Permission[]>;

export function builtInRoles(): RoleDefinition[] {
  return Object.entries(builtIns).map(([id, grants]) => ({
    id,
    name: id,
    permissions: [...grants],
    builtIn: true,
  }));
}

export function hasPermissions(role: RoleDefinition | undefined, required: Permission) {
  return role?.permissions.includes(required) ?? false;
}

export function mayDecideApproval(
  allowed: boolean,
  actorId: string,
  approval: { requestedBy: string; approverId: string },
) {
  return allowed && actorId === approval.approverId && actorId !== approval.requestedBy;
}
