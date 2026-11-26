import type { RequestJson } from '../platform-client.ts';
const root = '/ops';
export interface ServiceCheck {
  service: string;
  status: 'ok' | 'degraded' | 'down';
  detail?: string;
}
export interface OpsHealth {
  status: 'ok' | 'degraded' | 'down';
  checks: ServiceCheck[];
}
export interface OpsReadiness {
  ready: boolean;
  checks: ServiceCheck[];
}
export interface OpsMetrics {
  slos: { name: string; window: string; burnRate: number; target: number }[];
}
export interface OpsAlert {
  id: string;
  service: string;
  severity: 'warning' | 'critical';
  summary: string;
  startedAt: string;
}
export interface OpsClient {
  health(): Promise<OpsHealth>;
  readiness(): Promise<OpsReadiness>;
  metrics(): Promise<OpsMetrics>;
  alerts(): Promise<OpsAlert[]>;
}
export class HttpOpsClient implements OpsClient {
  private readonly request: RequestJson;
  constructor(request: RequestJson) {
    this.request = request;
  }
  health() {
    return this.request<OpsHealth>(root + '/health');
  }
  readiness() {
    return this.request<OpsReadiness>(root + '/ready');
  }
  metrics() {
    return this.request<OpsMetrics>(root + '/metrics');
  }
  alerts() {
    return this.request<OpsAlert[]>(root + '/alerts');
  }
}
