export const dataClasses = ['public', 'internal', 'personal', 'sensitive', 'financial'] as const;
export type DataClass = (typeof dataClasses)[number];

export const classifiedFields: Record<string, Readonly<Record<string, DataClass>>> = {
  contact: {
    id: 'internal',
    name: 'personal',
    email: 'personal',
    phone: 'personal',
    timeZone: 'personal',
  },
  consent: {
    id: 'internal',
    contactId: 'internal',
    channel: 'internal',
    purpose: 'internal',
    basis: 'internal',
    source: 'internal',
    evidenceRef: 'sensitive',
    destination: 'personal',
    grantedAt: 'internal',
    expiresAt: 'internal',
    withdrawnAt: 'internal',
    unsubscribeDigest: 'sensitive',
    unsubscribeToken: 'sensitive',
  },
  invoice: {
    id: 'internal',
    subjectId: 'internal',
    currency: 'public',
    amountCents: 'financial',
    taxCents: 'financial',
    settlementRef: 'sensitive',
  },
  audit: {
    id: 'internal',
    tenantId: 'internal',
    'actor.id': 'internal',
    'actor.kind': 'internal',
    source: 'internal',
    traceId: 'internal',
    correlationId: 'internal',
    actionId: 'internal',
    tool: 'internal',
    state: 'internal',
    policyVersion: 'internal',
    occurredAt: 'internal',
  },
  platformLog: { requestId: 'internal', operation: 'internal', error: 'sensitive' },
};

export function fieldClass(recordType: string, path: string) {
  const registry = Object.hasOwn(classifiedFields, recordType)
    ? classifiedFields[recordType]
    : undefined;
  return registry && Object.hasOwn(registry, path) ? registry[path] : undefined;
}

/** Redact unclassified fields as well as personal, sensitive and financial fields. */
export function redactFields(recordType: string, value: object) {
  function project(input: object, prefix: string): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => {
        // A literal dotted key must not masquerade as a registered nested path.
        if (key.includes('.')) return [key, '[redacted]'];
        const path = prefix + key;
        const classification = fieldClass(recordType, path);
        const registry = Object.hasOwn(classifiedFields, recordType)
          ? classifiedFields[recordType]
          : {};
        if (
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.keys(registry).some((field) => field.startsWith(path + '.'))
        ) {
          return [key, project(item, path + '.')];
        }
        const scalar = item === null || ['string', 'boolean', 'number'].includes(typeof item);
        return [
          key,
          scalar && (classification === 'public' || classification === 'internal')
            ? item
            : '[redacted]',
        ];
      }),
    );
  }
  return project(value, '');
}
