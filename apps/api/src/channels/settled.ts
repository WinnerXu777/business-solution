export type SettledTurn = {
  tenantId: string;
  conversationId: string;
  turnId: string;
  channel: 'web' | 'voice';
  outcome: string;
  /** Measured mono PCM duration in seconds, when available. */
  audioSeconds: number | null;
};

export type OnSettledTurn = (turn: SettledTurn) => void | Promise<void>;
