import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import { randomToken, tokenDigest } from './auth-crypto.ts';
import { dayMs, instant, iso } from './compliance-time.ts';
import { PlatformQueue, type TenantRepository } from './repository.ts';

export const contactChannels = ['email', 'sms', 'voice'] as const;
export const contactPurposes = ['marketing', 'collections', 'transactional'] as const;
export type ContactChannel = (typeof contactChannels)[number];
export type ContactPurpose = (typeof contactPurposes)[number];

export interface ContactProfile {
  timeZone: string;
  destinations: Partial<Record<ContactChannel, string>>;
  historyComplete: boolean;
  outreachAllowed: boolean;
  cadenceKey?: string;
}

export interface ContactPolicy {
  resolve(tenantId: string, contactId: string): Promise<ContactProfile | undefined>;
  nationalDoNotCall(destination: string): Promise<boolean>;
  blockedLocalDates?: readonly string[];
}

export interface ContactInput {
  contactId: string;
  channel: ContactChannel;
  purpose: ContactPurpose;
}

export type ConsentInput = ContactInput & {
  basis: 'express' | 'implied';
  source: string;
  evidenceRef: string;
  expiresAt?: string;
};

type Consent = ConsentInput & {
  id: string;
  destination: string;
  grantedAt: string;
  withdrawnAt?: string;
};

export type StoredConsent = Consent & { unsubscribeDigest: string };

export interface SuppressionInput {
  channel: ContactChannel;
  destination: string;
  reason: 'opt_out' | 'do_not_contact' | 'policy';
}

export type Suppression = SuppressionInput & {
  id: string;
  createdAt: string;
};

export interface ContactAttempt extends ContactInput {
  id: string;
  cadenceKey: string;
  at: string;
}

export type ContactReason =
  | 'platform_suppression'
  | 'tenant_suppression'
  | 'national_do_not_call'
  | 'contact_unavailable'
  | 'contact_blocked'
  | 'history_incomplete'
  | 'withdrawn'
  | 'consent_missing'
  | 'consent_expired'
  | 'express_required'
  | 'outside_contact_window'
  | 'contact_cap';

export type ContactDecision =
  | { allow: true; reasons: []; consentId: string }
  | { allow: false; reasons: ContactReason[] };

interface ContactRepositories {
  consents: TenantRepository<StoredConsent>;
  suppressions: TenantRepository<Suppression>;
  attempts: TenantRepository<ContactAttempt>;
}

const platformScope = '@platform-suppressions';
const cap = 3;
const capWindow = 7 * dayMs;
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function destinationFor(channel: ContactChannel, value?: string) {
  const normalized = value?.trim().toLowerCase();
  const pattern = channel === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/ : /^\+[1-9]\d{7,14}$/;
  return normalized && pattern.test(normalized) ? normalized : undefined;
}

function visible({ unsubscribeDigest: _, ...consent }: StoredConsent): Consent {
  return consent;
}

function inWindow(time: number, timeZone: string, blockedDates: readonly string[]) {
  try {
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      weekday: 'short',
      hourCycle: 'h23',
      hour: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const { weekday, hour, year, month, day } = Object.fromEntries(
      local.formatToParts(time).map(({ type, value }) => [type, value]),
    );
    return (
      weekdays.includes(weekday) &&
      Number(hour) >= 9 &&
      Number(hour) < 17 &&
      !blockedDates.includes([year, month, day].join('-'))
    );
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function suppressionId(channel: ContactChannel, destination: string) {
  return 'suppression-' + tokenDigest(JSON.stringify([channel, destination]));
}

export class ContactLedger {
  private readonly queue = new PlatformQueue();
  private readonly rows: ContactRepositories;
  private readonly audit: PlatformAudit;
  private readonly policy: ContactPolicy;
  private readonly now: () => string;
  private readonly onWithdrawal: (tenantId: string, consent: Consent) => Promise<unknown>;

  constructor(
    rows: ContactRepositories,
    audit: PlatformAudit,
    policy: ContactPolicy,
    now: () => string,
    onWithdrawal: ContactLedger['onWithdrawal'],
  ) {
    this.rows = rows;
    this.audit = audit;
    this.policy = policy;
    this.now = now;
    this.onWithdrawal = onWithdrawal;
  }

  async listConsents(tenantId: string) {
    return (await this.rows.consents.list(tenantId)).map(visible);
  }

  grant(context: MutationContext, input: ConsentInput) {
    const { tenantId } = context;
    return this.audit.transaction(tenantId, async () => {
      const profile = await this.policy.resolve(tenantId, input.contactId);
      const destination = destinationFor(input.channel, profile?.destinations[input.channel]);
      if (!destination) throw new PlatformError('not_found');
      const now = instant(this.now());
      const expiry = input.expiresAt === undefined ? undefined : instant(input.expiresAt);
      if (
        (input.basis === 'implied' && expiry === undefined) ||
        (expiry !== undefined && expiry <= now)
      )
        throw new PlatformError('forbidden', 'Consent expiry must be in the future.');
      const unsubscribeToken = randomToken();
      const consent: StoredConsent = {
        ...input,
        expiresAt: expiry === undefined ? undefined : iso(expiry),
        id: 'consent-' + randomUUID(),
        destination,
        grantedAt: iso(now),
        unsubscribeDigest: tokenDigest(unsubscribeToken),
      };
      await this.audit.record(context, 'platform.consent.grant', 'ok', consent.id);
      await this.rows.consents.put(tenantId, consent.id, consent);
      return { ...visible(consent), unsubscribeToken };
    });
  }

  withdraw(context: MutationContext, id: string) {
    const { tenantId } = context;
    return this.audit.transaction(tenantId, async () => {
      const consent = await this.rows.consents.get(tenantId, id);
      if (!consent) throw new PlatformError('not_found');
      if (!consent.withdrawnAt) {
        consent.withdrawnAt = this.now();
        await this.audit.record(context, 'platform.consent.withdraw', 'ok', id);
        await this.onWithdrawal(tenantId, visible(consent));
        await this.rows.consents.put(tenantId, id, consent);
      }
      return visible(consent);
    });
  }

  listSuppressions(tenantId: string, platform = false) {
    return this.rows.suppressions.list(platform ? platformScope : tenantId);
  }

  suppress(context: MutationContext, input: SuppressionInput, platform = false) {
    const tenantId = platform ? platformScope : context.tenantId;
    return this.queue.run(() =>
      this.audit.transaction(tenantId, () => this.saveSuppression({ ...context, tenantId }, input)),
    );
  }

  unsubscribe(tenantId: string, consentId: string, token: string) {
    return this.queue.run(() =>
      this.audit.transaction(tenantId, async () => {
        const consent = await this.rows.consents.get(tenantId, consentId);
        if (
          !consent ||
          !timingSafeEqual(Buffer.from(tokenDigest(token)), Buffer.from(consent.unsubscribeDigest))
        )
          return;
        const context: MutationContext = {
          tenantId,
          actor: { id: 'unsubscribe', kind: 'service' },
          source: 'rest',
          traceId: consentId,
          correlationId: consentId,
        };
        if (!consent.withdrawnAt) {
          consent.withdrawnAt = this.now();
          await this.onWithdrawal(tenantId, visible(consent));
          await this.rows.consents.put(tenantId, consentId, consent);
        }
        await this.saveSuppression(context, {
          channel: consent.channel,
          destination: consent.destination,
          reason: 'opt_out',
        });
      }),
    );
  }

  private async saveSuppression(context: MutationContext, input: SuppressionInput) {
    const destination = destinationFor(input.channel, input.destination);
    if (!destination) throw new PlatformError('forbidden');
    const { tenantId } = context;
    const id = suppressionId(input.channel, destination);
    const existing = await this.rows.suppressions.get(tenantId, id);
    if (existing) return existing;
    const suppression = { ...input, destination, id, createdAt: this.now() };
    await this.audit.record(context, 'platform.suppression.create', 'ok', id);
    await this.rows.suppressions.put(tenantId, id, suppression);
    return suppression;
  }

  canContact(
    tenantId: string,
    contactId: string,
    channel: ContactChannel,
    purpose: ContactPurpose,
    at?: string,
  ) {
    return this.check(
      tenantId,
      { contactId, channel, purpose },
      at === undefined ? this.now : () => at,
    );
  }

  /** Reserve immediately before dispatch. Keep attempts with uncertain outcomes in the cap. */
  reserveContact(tenantId: string, input: ContactInput, attemptId: string, recipient: string) {
    return this.check(tenantId, structuredClone(input), this.now, { attemptId, recipient });
  }

  logManualContact(tenantId: string, input: ContactInput, attemptId: string, at: string) {
    const occurrence = instant(at);
    return this.audit.transaction(tenantId, async () => {
      if (occurrence > instant(this.now())) throw new PlatformError('forbidden');
      const profile = await this.policy.resolve(tenantId, input.contactId);
      if (!profile) throw new PlatformError('not_found');
      const existing = await this.rows.attempts.get(tenantId, attemptId);
      if (existing) {
        if (
          existing.contactId !== input.contactId ||
          existing.purpose !== input.purpose ||
          existing.channel !== input.channel ||
          existing.at !== iso(occurrence)
        )
          throw new PlatformError('idempotency_conflict');
        return;
      }
      await this.saveAttempt(
        tenantId,
        {
          ...input,
          id: attemptId,
          cadenceKey: profile.cadenceKey ?? input.contactId,
          at: iso(occurrence),
        },
        'manual',
      );
    });
  }

  private check(
    tenantId: string,
    input: ContactInput,
    at: () => string,
    dispatch?: { attemptId: string; recipient: string },
  ) {
    return this.queue.run(async () => {
      const platform = await this.listSuppressions(tenantId, true);
      return this.audit.transaction(tenantId, async () => {
        const time = instant(at());
        const profile = await this.policy.resolve(tenantId, input.contactId);
        const destination = destinationFor(input.channel, profile?.destinations[input.channel]);
        if (
          !profile ||
          !destination ||
          (dispatch && destination !== destinationFor(input.channel, dispatch.recipient))
        )
          return this.deny('contact_unavailable');
        const id = suppressionId(input.channel, destination);
        if (platform.some((row) => row.id === id && instant(row.createdAt) <= time))
          return this.deny('platform_suppression');
        const suppression = await this.rows.suppressions.get(tenantId, id);
        if (suppression && instant(suppression.createdAt) <= time)
          return this.deny('tenant_suppression');
        if (input.channel === 'voice' && (await this.policy.nationalDoNotCall(destination)))
          return this.deny('national_do_not_call');
        if (!profile.outreachAllowed) return this.deny('contact_blocked');
        if (!profile.historyComplete) return this.deny('history_incomplete');
        const applicable = (await this.rows.consents.list(tenantId)).filter(
          (row) =>
            row.contactId === input.contactId &&
            row.channel === input.channel &&
            row.purpose === input.purpose &&
            row.destination === destination &&
            instant(row.grantedAt) <= time,
        );
        const lastWithdrawal = Math.max(
          -Infinity,
          ...applicable
            .filter((row) => row.withdrawnAt !== undefined && instant(row.withdrawnAt) <= time)
            .map((row) => instant(row.withdrawnAt!)),
        );
        const current = applicable.filter((row) => instant(row.grantedAt) > lastWithdrawal);
        const active = current.filter(
          (row) => row.expiresAt === undefined || instant(row.expiresAt) > time,
        );
        const expressRequired =
          input.channel === 'voice' || (input.channel === 'sms' && input.purpose === 'collections');
        const consent = active.find((row) => !expressRequired || row.basis === 'express');
        if (lastWithdrawal !== -Infinity && !current.length) return this.deny('withdrawn');
        if (!applicable.length) return this.deny('consent_missing');
        if (!active.length) return this.deny('consent_expired');
        if (!consent) return this.deny('express_required');
        if (!inWindow(time, profile.timeZone, this.policy.blockedLocalDates ?? []))
          return this.deny('outside_contact_window');

        const cadenceKey = profile.cadenceKey ?? input.contactId;
        const attempts = await this.rows.attempts.list(tenantId);
        if (dispatch && attempts.some((row) => row.id === dispatch.attemptId))
          throw new PlatformError('idempotency_conflict');
        const recent = attempts.filter((row) => {
          const occurrence = instant(row.at);
          return (
            row.cadenceKey === cadenceKey && occurrence > time - capWindow && occurrence <= time
          );
        });
        if (recent.length >= cap) return this.deny('contact_cap');
        if (dispatch) {
          const id = dispatch.attemptId;
          await this.saveAttempt(tenantId, { ...input, id, cadenceKey, at: iso(time) }, 'reserve');
        }
        return { allow: true, reasons: [], consentId: consent.id } satisfies ContactDecision;
      });
    });
  }

  private async saveAttempt(
    tenantId: string,
    attempt: ContactAttempt,
    action: 'manual' | 'reserve',
  ) {
    const id = tokenDigest(attempt.id);
    await this.rows.attempts.put(tenantId, attempt.id, attempt);
    await this.audit.record(
      {
        tenantId,
        actor: { id: 'platform-contact-policy', kind: 'service' },
        source: action === 'manual' ? 'rest' : 'workflow',
        traceId: id,
        correlationId: id,
      },
      'platform.contact_attempt.' + action,
      'ok',
      id,
    );
  }

  private deny(reason: ContactReason): ContactDecision {
    return { allow: false, reasons: [reason] };
  }
}
