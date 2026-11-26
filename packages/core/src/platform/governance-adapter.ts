import type {
  Approval,
  AuditEntry,
  CallEnvelope,
  Denied,
  Failed,
  UsageCounterEvent,
} from '@bs/contracts';
import type { GovernedGateway } from '../governance/index.ts';

export type PlatformApproval = Omit<Approval, 'state'> & {
  state: Exclude<Approval['state'], 'denied'> | 'rejected' | 'expired';
};

type Decision = Approval | PlatformApproval | Denied | Failed;

export type PlatformGovernance = Pick<GovernedGateway, 'call'> & {
  signApproval(envelope: CallEnvelope, id: string): Promise<Approval | Denied>;
  listApprovals?(tenantId: string): Promise<(Approval | PlatformApproval)[]>;
  rejectApproval?(envelope: CallEnvelope, id: string, reason: string): Promise<Decision>;
  reportingSnapshot?(
    tenantId: string,
  ): Promise<{ audit: AuditEntry[]; usage: UsageCounterEvent[] }>;
  listUsage?(tenantId: string): Promise<UsageCounterEvent[]>;
  audit?(): AuditEntry[];
  usage?(): UsageCounterEvent[];
};

export function deniedApproval(): Denied {
  return { state: 'denied', code: 'invalid_approval', message: 'invalid approval' };
}

/** The branch's fixture governance predates the public list and reject operations on main. */
export function fixtureApprovalAdapter(gateway: PlatformGovernance, now: () => string) {
  const ledger = Reflect.get(gateway, 'approvals') as object | undefined;
  const grants = ledger && (Reflect.get(ledger, 'grants') as Map<string, Approval> | undefined);
  const serialize = Reflect.get(gateway, 'serialize') as
    | (<T>(operation: () => T) => Promise<T>)
    | undefined;

  return {
    list(tenantId: string): Promise<(Approval | PlatformApproval)[]> {
      if (gateway.listApprovals) return gateway.listApprovals(tenantId);
      if (!grants || !serialize) throw new Error('Governance approval listing is required.');
      return serialize.call(gateway, () =>
        [...grants.values()]
          .filter((grant) => grant.tenantId === tenantId)
          .map(
            (grant): PlatformApproval => ({
              ...grant,
              state:
                grant.state === 'denied'
                  ? 'rejected'
                  : (grant.state === 'pending' || grant.state === 'approved') &&
                      Date.parse(grant.expiresAt) <= Date.parse(now())
                    ? 'expired'
                    : grant.state,
            }),
          ),
      ) as Promise<PlatformApproval[]>;
    },
    reject(envelope: CallEnvelope, id: string, reason: string): Promise<Decision> {
      if (gateway.rejectApproval) return gateway.rejectApproval(envelope, id, reason);
      if (!grants || !serialize) throw new Error('Governance approval rejection is required.');
      return serialize.call(gateway, () => {
        const grant = grants.get(id);
        if (
          !grant ||
          grant.tenantId !== envelope.tenantId ||
          grant.approverId !== envelope.actor.id ||
          grant.requestedBy === envelope.actor.id ||
          grant.state !== 'pending' ||
          Date.parse(grant.expiresAt) <= Date.parse(now())
        )
          return deniedApproval();
        grant.state = 'denied';
        return { ...grant, state: 'rejected' };
      }) as Promise<Decision>;
    },
  };
}
