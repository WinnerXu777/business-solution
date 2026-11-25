import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Customer,
  Order,
  RunForecastInput,
  RunForecastOutput,
  RunProfileOutput,
  ScoreFraudOutput,
} from '@bs/contracts';
import { supportingOrders } from './evidence.ts';
import type { ScoringAdapter } from './index.ts';

type WorkerRequest =
  | { operation: 'fraud'; order: Pick<Order, 'id' | 'totalCents' | 'signals'> }
  | { operation: 'forecast'; input: RunForecastInput; tenantId: string | null }
  | {
      operation: 'profile';
      customer: Pick<Customer, 'id' | 'lastOrderOn' | 'outreachAllowed'>;
      supportingOrders: string[];
    };

type WorkerOutput = {
  fraud: ScoreFraudOutput;
  forecast: RunForecastOutput;
  profile: RunProfileOutput;
};

type WorkerOptions = {
  python?: string;
  timeoutMs?: number;
};

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** Each call owns a short-lived local worker and one request and response line. */
export function createWorkerScoringAdapter(options: WorkerOptions = {}): ScoringAdapter {
  const python =
    options.python ??
    join(
      root,
      '.venv',
      ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']),
    );

  function run<Request extends WorkerRequest>(
    request: Request,
  ): Promise<WorkerOutput[Request['operation']]> {
    return new Promise((resolve, reject) => {
      const process = execFile(
        python,
        ['-E', '-s', '-X', 'utf8', '-m', 'workers.bs_worker.ml'],
        {
          cwd: root,
          timeout: options.timeoutMs ?? 10_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            reject(new Error('Local scoring worker unavailable.'));
            return;
          }
          try {
            const result: unknown = JSON.parse(stdout);
            if (
              result &&
              typeof result === 'object' &&
              'state' in result &&
              result.state === 'ok' &&
              'output' in result &&
              result.output &&
              typeof result.output === 'object'
            ) {
              // The worker validates each output against its generated Pydantic model.
              resolve(result.output as WorkerOutput[Request['operation']]);
              return;
            }
          } catch {
            // Report the protocol error without leaking process output or record fields.
          }
          reject(new Error('Local scoring worker returned an invalid result.'));
        },
      );
      process.stdin?.on('error', () => reject(new Error('Local scoring worker unavailable.')));
      process.stdin?.end(JSON.stringify(request) + '\n');
    });
  }

  return {
    fraud({ id, totalCents, signals }) {
      return run({ operation: 'fraud', order: { id, totalCents, signals } });
    },
    forecast(input, tenantId) {
      return run({ operation: 'forecast', input, tenantId: tenantId ?? null });
    },
    profile(customer) {
      const { id, lastOrderOn, outreachAllowed } = customer;
      return run({
        operation: 'profile',
        customer: { id, lastOrderOn, outreachAllowed },
        supportingOrders: supportingOrders(customer),
      });
    },
  };
}
