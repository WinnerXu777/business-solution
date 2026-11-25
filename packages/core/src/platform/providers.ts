import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import { PlatformQueue, type TenantRepository } from './repository.ts';

const labels = {
  llm: 'LLM',
  embeddings: 'Embeddings',
  chat: 'Chat',
  'contact-centre': 'Contact centre',
  telephony: 'Telephony',
  'speech-to-text': 'Speech to text',
  'text-to-speech': 'Text to speech',
  email: 'Email',
  sms: 'SMS',
  crm: 'CRM',
  erp: 'ERP',
  accounting: 'Accounting',
  'ml-scoring': 'ML scoring',
  workflow: 'Workflow',
};

export type Capability = keyof typeof labels;
export const capabilities = Object.keys(labels) as Capability[];
type Mode = 'native' | 'byo' | 'premium';
export type DataClass = 'synthetic' | 'business-records' | 'contact-data' | 'voice-recording';
const canada = 'ca-central-1';
const canadaRegions = new Set([canada, 'ca-west-1', 'canadacentral', 'canadaeast']);
const allData: DataClass[] = ['synthetic', 'business-records', 'contact-data', 'voice-recording'];

interface Provider {
  providerId: string;
  capability: Capability;
  name: string;
  mode: Mode;
  regions: string[];
  features: string[];
  notes: string;
  dataClasses: DataClass[];
}

function native(capability: Capability, name: string, features: string[]): Provider {
  return {
    providerId: capability === 'llm' ? 'fixture-native' : 'native-' + capability,
    capability,
    name,
    mode: 'native',
    regions: [canada],
    features,
    notes: 'Native fixture. No live provider calls.',
    dataClasses: allData,
  };
}

function option(
  capability: Capability,
  providerId: string,
  name: string,
  mode: Exclude<Mode, 'native'>,
  region: string,
  features: string[],
  notes: string,
  dataClasses: DataClass[] = ['synthetic'],
): Provider {
  return { capability, providerId, name, mode, regions: [region], features, notes, dataClasses };
}

// Candidate routes come from the local master-plan provider research. Regions describe
// fixture routing policy and refer to processing, not service availability or storage alone.
const providers: Provider[] = [
  native('llm', 'llama.cpp', ['streaming', 'structured-output']),
  native('embeddings', 'Local embeddings', ['vector-search']),
  native('chat', 'LangGraph web chat', ['web-widget', 'handoff']),
  native('contact-centre', 'Asterisk contact centre', ['queues', 'handoff']),
  native('telephony', 'Asterisk telephony', ['sip', 'simulated-delivery']),
  native('speech-to-text', 'Whisper', ['transcription']),
  native('text-to-speech', 'Piper', ['speech-synthesis']),
  native('email', 'Mailpit', ['local-inbox']),
  native('sms', 'SMS simulator', ['simulated-delivery']),
  native('crm', 'Native CRM', ['contacts', 'consent']),
  native('erp', 'Native ERP', ['orders', 'inventory']),
  native('accounting', 'Native accounting', ['receivables', 'csv-export']),
  native('ml-scoring', 'Local scoring', ['fraud-review', 'forecast']),
  native('workflow', 'Native workflow runner', ['preview', 'approval']),
  option(
    'llm',
    'openai',
    'OpenAI',
    'byo',
    'global',
    ['streaming', 'structured-output'],
    'Direct API. Canadian storage eligibility does not establish Canadian inference.',
  ),
  option(
    'llm',
    'anthropic',
    'Anthropic',
    'byo',
    'global',
    ['streaming', 'tool-calling'],
    'Direct Claude API. Canada-only processing is unverified.',
  ),
  option(
    'llm',
    'amazon-bedrock',
    'Amazon Bedrock',
    'premium',
    canada,
    ['streaming', 'tool-calling'],
    'Candidate for a Canada-only model profile.',
    allData,
  ),
  option(
    'embeddings',
    'openai',
    'OpenAI embeddings',
    'byo',
    'global',
    ['vector-search'],
    'Canada-only inference is unverified.',
  ),
  option(
    'embeddings',
    'cohere-vault',
    'Cohere Model Vault',
    'premium',
    canada,
    ['embeddings', 'reranking'],
    'Canadian private deployment candidate.',
    allData,
  ),
  option(
    'chat',
    'chatwoot',
    'Chatwoot',
    'byo',
    canada,
    ['shared-inbox', 'web-widget'],
    'Canadian self-hosted deployment.',
    allData,
  ),
  option(
    'contact-centre',
    'ringcentral-ringcx',
    'RingCentral RingCX',
    'premium',
    'global',
    ['queues', 'agent-handoff'],
    'Canadian end-to-end audio and record residency requires qualification.',
  ),
  option(
    'contact-centre',
    'amazon-connect',
    'Amazon Connect',
    'premium',
    canada,
    ['queues', 'ivr'],
    'Regional contact centre candidate. Confirm downstream routing.',
    allData,
  ),
  option(
    'telephony',
    'twilio',
    'Twilio Programmable Voice',
    'byo',
    'global',
    ['sip', 'call-control'],
    'Canadian numbers do not establish end-to-end residency.',
  ),
  option(
    'telephony',
    'telnyx',
    'Telnyx',
    'byo',
    'global',
    ['sip', 'call-control'],
    'Canadian storage covers selected data classes.',
  ),
  option(
    'speech-to-text',
    'elevenlabs',
    'ElevenLabs Scribe',
    'premium',
    'global',
    ['streaming', 'transcription'],
    'Canadian processing region unverified.',
  ),
  option(
    'speech-to-text',
    'azure-speech',
    'Azure AI Speech',
    'premium',
    'canadacentral',
    ['streaming', 'transcription'],
    'Regional deployment candidate. Confirm feature matrix.',
    allData,
  ),
  option(
    'text-to-speech',
    'elevenlabs',
    'ElevenLabs',
    'premium',
    'global',
    ['streaming', 'speech-synthesis'],
    'Canadian processing region unverified.',
  ),
  option(
    'text-to-speech',
    'azure-speech',
    'Azure AI Speech',
    'premium',
    'canadacentral',
    ['speech-synthesis'],
    'Regional deployment candidate. Confirm voices available.',
    allData,
  ),
  option(
    'email',
    'microsoft-graph',
    'Microsoft Graph',
    'byo',
    'global',
    ['mailbox', 'delivery'],
    'Confirm the full tenant mail path separately.',
  ),
  option(
    'sms',
    'twilio',
    'Twilio Programmable Messaging',
    'byo',
    'global',
    ['sms', 'delivery-receipts'],
    'Canadian processing and storage are unverified.',
  ),
  option(
    'crm',
    'hubspot',
    'HubSpot',
    'byo',
    'global',
    ['contacts', 'deals'],
    'Canadian end-to-end residency is unverified.',
  ),
  option(
    'erp',
    'erpnext',
    'ERPNext',
    'byo',
    canada,
    ['inventory', 'orders'],
    'Canadian self-hosted deployment.',
    allData,
  ),
  option(
    'accounting',
    'quickbooks-online',
    'QuickBooks Online',
    'byo',
    'global',
    ['sandbox', 'receivables'],
    'Canadian sandbox availability does not establish data residency.',
  ),
  option(
    'ml-scoring',
    'stripe-radar',
    'Stripe Radar',
    'premium',
    'global',
    ['fraud-review'],
    'Canadian end-to-end processing is unverified.',
  ),
  option(
    'workflow',
    'temporal-cloud',
    'Temporal Cloud',
    'premium',
    canada,
    ['durable-execution', 'versioning'],
    'Canadian namespace candidate. Confirm history and backup scope.',
    allData,
  ),
];

export class ProviderRegistry {
  list(capability?: string) {
    return structuredClone(
      providers.filter((row) => capability === undefined || row.capability === capability),
    );
  }

  get(capability: Capability, providerId: string) {
    return this.list(capability).find((row) => row.providerId === providerId);
  }

  defaultFor(capability: Capability) {
    const provider = this.list(capability).find((row) => row.mode === 'native');
    if (!provider) throw new PlatformError('unavailable');
    return provider;
  }
}

const syntheticOnly = new Set<Capability>(['llm', 'embeddings', 'text-to-speech']);
const contactData = new Set<Capability>(['chat', 'email', 'sms', 'crm']);
const voiceData = new Set<Capability>(['contact-centre', 'telephony', 'speech-to-text']);
const fallbackCapabilities = new Set<Capability>([
  'llm',
  'embeddings',
  'speech-to-text',
  'text-to-speech',
  'ml-scoring',
]);

export function fixtureDataClasses(_tenantId: string, capability: Capability): DataClass[] {
  if (syntheticOnly.has(capability)) return ['synthetic'];
  if (contactData.has(capability)) return ['contact-data'];
  if (voiceData.has(capability)) return ['voice-recording'];
  return ['business-records'];
}

export const credentialReferencePattern =
  /^(?:fixture:[a-zA-Z][a-zA-Z0-9._-]{0,63}|vault:\/\/[a-zA-Z][a-zA-Z0-9._/-]{0,127})$/;

interface BindingView {
  providerId: string;
  mode: Mode;
  status: 'active' | 'pending' | 'error';
  region: string;
  dataClasses: DataClass[];
  fallbackProviderId: string | null;
  version: number;
}

export interface BindingRevision {
  binding: BindingView;
  credentialRef?: string;
}

export interface BindingInput {
  providerId: string;
  credentialRef?: string;
  fallbackProviderId?: string;
}

export class CapabilityBindingStore {
  private readonly queue = new PlatformQueue();
  private readonly providers: ProviderRegistry;
  private readonly revisions: TenantRepository<BindingRevision[]>;
  private readonly audit: PlatformAudit;
  private readonly dataClasses: typeof fixtureDataClasses;

  constructor(
    providers: ProviderRegistry,
    revisions: TenantRepository<BindingRevision[]>,
    audit: PlatformAudit,
    dataClasses = fixtureDataClasses,
  ) {
    this.providers = providers;
    this.revisions = revisions;
    this.audit = audit;
    this.dataClasses = dataClasses;
  }

  private region(provider: Provider, data: DataClass[]) {
    const requiresCanada = data.some((dataClass) => dataClass !== 'synthetic');
    const region = provider.regions.find((item) => !requiresCanada || canadaRegions.has(item));
    if (!region || !data.every((dataClass) => provider.dataClasses.includes(dataClass))) {
      throw new PlatformError(
        'forbidden',
        'Provider does not support the required data classes and region.',
      );
    }
    return region;
  }

  async history(tenantId: string, capability: Capability): Promise<BindingRevision[]> {
    const history = await this.revisions.get(tenantId, capability);
    if (history) return history;
    const provider = this.providers.defaultFor(capability);
    const dataClasses = this.dataClasses(tenantId, capability);
    return [
      {
        binding: {
          providerId: provider.providerId,
          mode: 'native',
          status: 'active',
          region: this.region(provider, dataClasses),
          dataClasses,
          fallbackProviderId: null,
          version: 1,
        },
      },
    ];
  }

  list(tenantId: string) {
    return Promise.all(
      capabilities.map(async (capability) => ({
        capability,
        label: labels[capability],
        binding: (await this.history(tenantId, capability)).at(-1)!.binding,
      })),
    );
  }

  bind(context: MutationContext, name: string, input: BindingInput) {
    const snapshot = structuredClone(input);
    return this.queue.run(() => this.update(context, name, snapshot));
  }

  private async update(context: MutationContext, name: string, input: BindingInput) {
    if (!Object.hasOwn(labels, name)) throw new PlatformError('not_found');
    const capability = name as Capability;
    const { providerId, credentialRef, fallbackProviderId } = input;
    const provider = this.providers.get(capability, providerId);
    if (!provider) throw new PlatformError('not_found');
    const dataClasses = this.dataClasses(context.tenantId, capability);
    const region = this.region(provider, dataClasses);
    if (credentialRef !== undefined && !credentialReferencePattern.test(credentialRef)) {
      throw new PlatformError('forbidden', 'A named credential reference is required.');
    }
    if (fallbackProviderId !== undefined) {
      const fallback = this.providers.get(capability, fallbackProviderId);
      if (!fallback) throw new PlatformError('not_found');
      if (!fallbackCapabilities.has(capability) || fallbackProviderId === providerId) {
        throw new PlatformError('forbidden', 'Fallback is unavailable for this binding.');
      }
      this.region(fallback, dataClasses);
    }
    const history = await this.history(context.tenantId, capability);
    const binding: BindingView = {
      providerId,
      mode: provider.mode,
      status: provider.mode === 'native' || credentialRef ? 'active' : 'pending',
      region,
      dataClasses,
      fallbackProviderId: fallbackProviderId ?? null,
      version: history.length + 1,
    };
    await this.audit.record(context, 'platform.binding.update');
    await this.revisions.put(context.tenantId, capability, [
      ...history,
      { binding, credentialRef },
    ]);
    return binding;
  }
}
