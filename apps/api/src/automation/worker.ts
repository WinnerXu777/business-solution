import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type {
  Approval,
  CallEnvelope,
  MessagePreview,
  PurchaseOrderDraft,
  RunChatInput,
  ToolCall,
  ToolResult,
} from '@bs/contracts';
import type { ToolGateway } from '@bs/core';
import type { ToolProposal } from '../../../../packages/adapters/src/llm/index.ts';

export type ApprovalMaterial = {
  approval: Approval;
  draft?: PurchaseOrderDraft;
  previews?: MessagePreview[];
};

type WorkerCommand =
  | {
      kind: 'chat';
      threadId: string;
      envelope: CallEnvelope;
      chat: RunChatInput;
      proposal: ToolProposal | null;
    }
  | { kind: 'resume'; threadId: string; envelope: CallEnvelope }
  | {
      kind: 'workflow';
      envelope: CallEnvelope;
      mode: 'preview' | 'run';
      approvalId: string | null;
    };

type WorkerReply = { result: ToolResult; pending?: ApprovalMaterial };
type WorkerMessage = WorkerReply | { toolCall: ToolCall } | { error: string };
const repo = new URL('../../../../', import.meta.url);

export function createWorker(gateway: ToolGateway, python?: string) {
  const interpreter = fileURLToPath(
    new URL(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', repo),
  );
  let session: ReturnType<typeof start> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  function start() {
    const child = spawn(
      python ?? process.env.BS_WORKER_PYTHON ?? (existsSync(interpreter) ? interpreter : 'python'),
      ['-m', 'workers.bs_worker.chat.stdio'],
      { cwd: repo, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    const lines = createInterface({ input: child.stdout });
    const stop = () => {
      lines.close();
      child.kill();
    };
    child.on('error', stop);
    child.stdin.on('error', stop);
    return { child, reader: lines[Symbol.asyncIterator](), stop };
  }

  async function execute(command: WorkerCommand): Promise<WorkerReply> {
    if (closed) throw new Error('Fixture worker closed.');
    const { child, reader, stop } = (session ??= start());
    const timer = setTimeout(stop, 20_000);
    try {
      child.stdin.write(JSON.stringify(command) + '\n');
      for (;;) {
        const line = await reader.next();
        if (line.done) throw new Error('Fixture worker disconnected.');
        const message = JSON.parse(line.value) as WorkerMessage;
        if ('error' in message) throw new Error(message.error);
        if ('result' in message) return message;
        const result = await gateway.call(message.toolCall);
        child.stdin.write(JSON.stringify(result) + '\n');
      }
    } catch (error) {
      // Keep one worker per session. A disconnected worker loses its checkpoints.
      stop();
      closed = true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    invoke(command: WorkerCommand) {
      const task = queue.then(() => execute(command));
      queue = task.catch(() => undefined);
      return task;
    },
    close() {
      closed = true;
      session?.stop();
    },
  };
}
