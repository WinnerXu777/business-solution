import type { MessageChannel, ToolResult } from '@bs/contracts';

export const channels: { id: MessageChannel; name: string }[] = [
  { id: 'email', name: 'Email' },
  { id: 'voice', name: 'Voice' },
  { id: 'sms', name: 'SMS' },
];
export const money = (cents: number) =>
  Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);

export function resultText(result: ToolResult): string {
  if (result.state === 'pending_approval') return 'Added to the approval inbox.';
  if (result.state !== 'ok') {
    if (result.state === 'denied' && result.code === 'suppressed') {
      return 'Outreach is on hold for this invoice.';
    }
    if (result.state === 'denied' && result.code === 'not_found') {
      return 'Record unavailable.';
    }
    return result.message;
  }
  const output = result.output;
  if ('reply' in output) return output.reply;
  if ('draft' in output) {
    return 'approval' in output
      ? 'Purchase order draft added to the approval inbox.'
      : 'Purchase order approved · ' + output.id;
  }
  if ('providerId' in output && 'status' in output) {
    return output.status === 'captured' ? 'Email captured in Mailpit.' : 'Delivery simulated.';
  }
  if ('receipts' in output) {
    return output.status === 'previewed'
      ? 'Preview ready · 0 deliveries'
      : 'Workflow completed · ' + output.receipts.length + ' receipts';
  }
  return 'Ready.';
}
