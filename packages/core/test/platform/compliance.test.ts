import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeProviders } from '@bs/adapters';
import type { CallEnvelope } from '@bs/contracts';
import {
  createPlatformServices,
  fieldClass,
  fixtureAdmin,
  redactFields,
  type ContactInput,
  type ContactProfile,
  type GovernedRecord,
  type MutationContext,
  type RecordRef,
} from '../../src/platform/index.ts';

const context = {
  ...fixtureAdmin,
  source: 'rest',
  traceId: 'trace',
  correlationId: 'trace',
} satisfies MutationContext;
const tenantId = context.tenantId;
const otherTenant = 'tenant-spoolharbour';
const start = '2026-11-25T15:00:00.000Z';
const email: ContactInput = { contactId: 'cust-002', channel: 'email', purpose: 'collections' };
const sms: ContactInput = { ...email, channel: 'sms' };
const voice: ContactInput = { ...email, channel: 'voice' };
const grant = { basis: 'express', source: 'fixture-form', evidenceRef: 'agreement-1' } as const;

function setup() {
  let at = start;
  const profiles = new Map<string, ContactProfile>([
    [
      'cust-002',
      {
        timeZone: 'America/Toronto',
        destinations: {
          email: 'orders2@rivetquay.example',
          sms: '+14165550102',
          voice: '+14165550102',
        },
        historyComplete: true,
        outreachAllowed: true,
      },
    ],
    [
      'pacific',
      {
        timeZone: 'America/Vancouver',
        destinations: {
          email: 'dispatch@spoolharbour.example',
          voice: '+14165550107',
        },
        historyComplete: true,
        outreachAllowed: true,
      },
    ],
  ]);
  return {
    ...createPlatformServices({
      now: () => at,
      contactPolicy: {
        async resolve(tenant, id) {
          return tenant === tenantId || tenant === otherTenant ? profiles.get(id) : undefined;
        },
        async nationalDoNotCall(number) {
          return number === '+14165550107';
        },
        blockedLocalDates: ['2026-11-26'],
      },
    }),
    advance(next: string) {
      at = next;
    },
    profiles,
  };
}

test('consent is scoped by tenant, channel, purpose and destination and expires at its boundary', async () => {
  const { contacts, advance, profiles } = setup();
  await assert.rejects(contacts.grant(context, { ...email, ...grant, basis: 'implied' }), {
    code: 'forbidden',
  });
  const consent = await contacts.grant(context, {
    ...email,
    ...grant,
    basis: 'implied',
    expiresAt: '2026-11-25T16:00:00Z',
  });
  assert.deepEqual(
    await contacts.canContact(tenantId, email.contactId, 'email', 'collections', start),
    { allow: true, reasons: [], consentId: consent.id },
  );
  assert.equal(
    (await contacts.canContact(otherTenant, email.contactId, 'email', 'collections', start)).allow,
    false,
  );
  assert.equal(
    (await contacts.canContact(tenantId, email.contactId, 'sms', 'collections', start)).allow,
    false,
  );
  assert.equal(
    (await contacts.canContact(tenantId, email.contactId, 'email', 'marketing', start)).allow,
    false,
  );
  const profile = profiles.get(email.contactId)!;
  profiles.set(email.contactId, {
    ...profile,
    destinations: { ...profile.destinations, email: 'changed@rivetquay.example' },
  });
  assert.deepEqual(
    (await contacts.canContact(tenantId, email.contactId, 'email', 'collections', start)).reasons,
    ['consent_missing'],
  );
  profiles.set(email.contactId, profile);
  advance('2026-11-25T16:00:00Z');
  assert.deepEqual(
    (await contacts.canContact(tenantId, email.contactId, 'email', 'collections')).reasons,
    ['consent_expired'],
  );
  const second = await contacts.grant(context, { ...email, ...grant });
  const third = await contacts.grant(context, { ...email, ...grant });
  assert.equal(
    (await contacts.listConsents(tenantId)).some(
      (row) => 'unsubscribeToken' in row || 'unsubscribeDigest' in row,
    ),
    false,
  );
  await assert.rejects(contacts.withdraw({ ...context, tenantId: otherTenant }, second.id), {
    code: 'not_found',
  });
  await contacts.withdraw(context, second.id);
  assert.deepEqual(
    (await contacts.canContact(tenantId, email.contactId, 'email', 'collections')).reasons,
    ['withdrawn'],
  );
  advance('2026-11-25T16:01:00Z');
  await contacts.grant(context, { ...email, ...grant });
  assert.equal(
    (await contacts.canContact(tenantId, email.contactId, 'email', 'collections')).allow,
    true,
  );
  await contacts.unsubscribe(tenantId, third.id, second.unsubscribeToken);
  assert.equal((await contacts.listSuppressions(tenantId)).length, 0);
  await contacts.unsubscribe(tenantId, third.id, third.unsubscribeToken);
  assert.deepEqual(
    (await contacts.canContact(tenantId, email.contactId, 'email', 'collections')).reasons,
    ['tenant_suppression'],
  );
  await contacts.suppress(
    context,
    { channel: 'email', destination: 'ORDERS2@RIVETQUAY.EXAMPLE', reason: 'policy' },
    true,
  );
  for (const tenant of [tenantId, otherTenant]) {
    assert.deepEqual(
      (await contacts.canContact(tenant, email.contactId, 'email', 'collections')).reasons,
      ['platform_suppression'],
    );
  }
});

test('contact windows use recipient time including DST and fixture holidays, and voice checks the DNCL', async () => {
  const { contacts, advance } = setup();
  for (const input of [
    email,
    { ...email, contactId: 'pacific' },
    { ...voice, contactId: 'pacific' },
  ])
    await contacts.grant(context, { ...input, ...grant });
  assert.equal(
    (await contacts.canContact(tenantId, email.contactId, 'email', 'collections')).allow,
    true,
  );
  assert.deepEqual(
    (await contacts.canContact(tenantId, 'pacific', 'email', 'collections')).reasons,
    ['outside_contact_window'],
  );
  assert.deepEqual(
    (await contacts.canContact(tenantId, 'pacific', 'voice', 'collections')).reasons,
    ['national_do_not_call'],
  );
  advance('2026-11-25T17:00:00Z');
  assert.equal(
    (await contacts.canContact(tenantId, 'pacific', 'email', 'collections')).allow,
    true,
  );
  advance('2026-11-26T18:00:00Z');
  assert.deepEqual(
    (await contacts.canContact(tenantId, 'pacific', 'email', 'collections')).reasons,
    ['outside_contact_window'],
  );
  advance('2027-03-15T16:00:00Z');
  assert.equal(
    (await contacts.canContact(tenantId, 'pacific', 'email', 'collections')).allow,
    true,
  );
});

test('reservations serialize cross-channel caps, include manual attempts and check recipient changes', async () => {
  const { contacts, advance, profiles } = setup();
  for (const input of [email, sms, voice]) await contacts.grant(context, { ...input, ...grant });
  await contacts.logManualContact(tenantId, sms, 'manual', start);
  const reserve = (input: ContactInput, id: string) =>
    contacts.reserveContact(
      tenantId,
      input,
      id,
      profiles.get(input.contactId)!.destinations[input.channel]!,
    );
  assert.deepEqual(
    (await contacts.reserveContact(tenantId, email, 'wrong', 'other@rivetquay.example')).reasons,
    ['contact_unavailable'],
  );
  const decisions = await Promise.all([
    reserve(email, 'auto1'),
    reserve(voice, 'auto2'),
    reserve(sms, 'auto3'),
  ]);
  assert.equal(decisions.filter(({ allow }) => allow).length, 2);
  assert.deepEqual(decisions.find(({ allow }) => !allow)?.reasons, ['contact_cap']);
  advance('2026-12-02T15:00:00Z');
  assert.equal((await reserve(sms, 'next')).allow, true);
  profiles.get(email.contactId)!.historyComplete = false;
  assert.deepEqual((await reserve(email, 'missing-history')).reasons, ['history_incomplete']);
});

test('guarded fixture gateway checks approved outbound effects against current consent', async () => {
  const providers = createFakeProviders();
  let sent = 0;
  const { gateway, contacts } = createPlatformServices({
    now: () => start,
    fixtureMessages: {
      ...providers.messages,
      email: {
        send(preview, id) {
          sent++;
          return providers.messages.email.send(preview, id);
        },
      },
    },
  });
  const envelope: CallEnvelope = {
    ...context,
    actor: { id: 'actor-operator', kind: 'person' },
    version: 'v1',
    idempotencyKey: 'preview',
  };
  const preview = await gateway.call({
    envelope,
    tool: 'collections.email.draft',
    input: { invoiceId: 'inv-001' },
  });
  assert.equal(preview.state, 'ok', JSON.stringify(preview));
  if (preview.state !== 'ok') return;
  const consent = await contacts.grant(context, { ...email, ...grant });
  const input = { previewId: preview.output.id, approvalId: null };
  const pending = await gateway.call({
    envelope: { ...envelope, idempotencyKey: 'request' },
    tool: 'collections.email.send',
    input,
  });
  assert.equal(pending.state, 'pending_approval');
  if (pending.state !== 'pending_approval') return;
  await gateway.signApproval(
    {
      ...envelope,
      actor: { id: 'actor-approver', kind: 'person' },
      idempotencyKey: 'sign',
    },
    pending.approval.id,
  );
  await contacts.withdraw(context, consent.id);
  const result = await gateway.call({
    envelope: { ...envelope, idempotencyKey: 'send' },
    tool: 'collections.email.send',
    input: { ...input, approvalId: pending.approval.id },
  });
  assert.equal(result.state, 'failed');
  if (result.state === 'failed') assert.equal(result.message, 'withdrawn');
  assert.equal(sent, 0);
});

test('privacy verifies subject evidence, scopes exports, and defers deletion until holds and minimums clear', async () => {
  let at = start;
  const subjectId = 'subject-demo';
  const customer: GovernedRecord = {
    id: 'contact-demo',
    version: '1',
    tenantId,
    subjectId,
    recordType: 'contact',
    dataClass: 'personal',
    retainedFrom: '2024-01-01T00:00:00Z',
    fields: { email: 'subject@example.test' },
  };
  const invoice: GovernedRecord = {
    ...customer,
    id: 'invoice-demo',
    recordType: 'invoice',
    dataClass: 'internal',
    retainedFrom: '2023-01-01T00:00:00Z',
    fields: { amountCents: 4500, currency: 'CAD' },
  };
  let records = [
    customer,
    invoice,
    { ...customer, id: 'other-tenant', tenantId: otherTenant },
    { ...customer, id: 'other-subject', subjectId: 'other', retainedFrom: start },
    {
      ...customer,
      id: 'unclassified',
      subjectId: 'other',
      fields: { id: { unexpected: 'value' } },
    },
  ];
  const deletes: RecordRef[][] = [];
  const { privacy, queries } = createPlatformServices({
    now: () => at,
    privacy: {
      async verifyIdentity(tenant, subject, id, proofRef) {
        return tenant === tenantId && subject === subjectId && proofRef === 'verified-' + id;
      },
      records: {
        async list() {
          return records;
        },
        async delete(tenant, subject, _operationId, refs) {
          assert.equal(tenant, tenantId);
          assert.equal(subject, subjectId);
          deletes.push([...refs]);
          records = records.filter(
            (row) =>
              row.tenantId !== tenant ||
              row.subjectId !== subject ||
              !refs.some(({ id, version }) => id === row.id && version === row.version),
          );
          return refs.length;
        },
      },
    },
  });
  const access = await privacy.create(context, { kind: 'access', subjectId });
  assert.equal(access.dueAt, '2026-12-25T15:00:00.000Z');
  await assert.rejects(privacy.complete(context, access.id), { code: 'forbidden' });
  await assert.rejects(privacy.verify(context, access.id, { proofRef: 'unmatched' }), {
    code: 'forbidden',
  });
  await assert.rejects(
    privacy.verify({ ...context, tenantId: otherTenant }, access.id, {
      proofRef: 'verified-' + access.id,
    }),
    { code: 'not_found' },
  );
  await privacy.verify(context, access.id, { proofRef: 'verified-' + access.id });
  const result = await privacy.complete(context, access.id);
  assert.deepEqual(
    result.bundle?.records.map(({ id }) => id),
    [customer.id, invoice.id],
  );
  assert.equal(JSON.stringify(await queries.audit(tenantId, {})).includes('verified-'), false);
  const hold = await privacy.addHold(context, {
    dataClass: 'financial',
    reasonRef: 'fixture-tax-review',
    subjectId,
  });
  const report = await privacy.dryRun(tenantId);
  assert.equal(report.items.find(({ id }) => id === invoice.id)?.status, 'held');
  assert.equal(report.items.find(({ id }) => id === customer.id)?.status, 'eligible');
  assert.equal(report.items.find(({ id }) => id === 'other-subject')?.status, 'scheduled');
  assert.equal(report.items.find(({ id }) => id === 'unclassified')?.status, 'unclassified');
  assert.equal(
    report.items.some(({ id }) => id === 'other-tenant'),
    false,
  );
  assert.deepEqual(deletes, []);
  const deletion = await privacy.create(context, { kind: 'deletion', subjectId });
  await privacy.verify(context, deletion.id, { proofRef: 'verified-' + deletion.id });
  let completed = (await privacy.complete(context, deletion.id)).request;
  assert.equal(completed.status, 'retention_blocked');
  assert.deepEqual(completed.deletion?.blocked[0].reasons, ['hold', 'minimum_retention']);
  at = '2030-01-01T12:00:00Z';
  await privacy.releaseHold(context, hold.id);
  completed = (await privacy.complete(context, deletion.id)).request;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.deletion?.deleted, 2);
  assert.deepEqual(
    completed.history.map(({ status }) => status),
    ['pending_verification', 'verified', 'retention_blocked', 'completed'],
  );
  await privacy.complete(context, deletion.id);
  assert.equal(deletes.length, 1);
  assert.deepEqual(
    records.map(({ id }) => id),
    ['other-tenant', 'other-subject', 'unclassified'],
  );
});

test('redaction preserves registered safe scalars and masks nested and unclassified values', () => {
  assert.equal(fieldClass('invoice', 'amountCents'), 'financial');
  assert.deepEqual(
    redactFields('contact', { id: 'demo', email: 'subject@example.test', extra: 'leak' }),
    { id: 'demo', email: '[redacted]', extra: '[redacted]' },
  );
  assert.deepEqual(
    redactFields('audit', {
      actor: { id: 'demo', kind: 'person', phone: '+14165550102' },
      traceId: { token: 'fixture-secret' },
      'actor.id': 'unregistered-flat',
    }),
    {
      actor: { id: 'demo', kind: 'person', phone: '[redacted]' },
      traceId: '[redacted]',
      'actor.id': '[redacted]',
    },
  );
});
