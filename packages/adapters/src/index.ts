import type {
  CompleteLlmInput,
  CompleteLlmOutput,
  Customer,
  DeliveryReceipt,
  Failed,
  MessageChannel,
  MessagePreview,
  Order,
  RunForecastInput,
  RunForecastOutput,
  RunProfileOutput,
  ScoreFraudOutput,
  Unknown,
} from '@bs/contracts';

type ProviderResult<Output> = Output | Promise<Output>;

export interface LlmAdapter {
  complete(input: CompleteLlmInput): ProviderResult<CompleteLlmOutput>;
}

export interface MessageAdapter {
  send(
    preview: MessagePreview,
    actionId: string,
  ): ProviderResult<DeliveryReceipt | Failed | Unknown>;
  reconcile?(actionId: string): ProviderResult<DeliveryReceipt | 'not_applied' | 'unknown'>;
}

export interface ScoringAdapter {
  fraud(order: Order): ProviderResult<ScoreFraudOutput>;
  forecast(input: RunForecastInput, tenantId: string): ProviderResult<RunForecastOutput>;
  profile(customer: Customer): ProviderResult<RunProfileOutput>;
}

export interface ProviderAdapters {
  llm: LlmAdapter;
  messages: Record<MessageChannel, MessageAdapter>;
  scoring: ScoringAdapter;
}

export { createFakeProviders } from './fake-providers.ts';
