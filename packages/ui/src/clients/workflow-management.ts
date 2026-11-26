import type { RequestJson } from '../platform-client.ts';
import type { WorkflowDefinition, WorkflowNode } from './workflow-definition.ts';
const root = '/workflows';
export type TemplateValues = Record<string, string>;
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  parameters: { key: string; label: string; defaultValue?: string; required: boolean }[];
}
export interface TemplatePreview {
  definition: WorkflowDefinition;
}
export interface InstalledWorkflow extends TemplatePreview {
  status: 'draft';
}
export type WorkflowTrigger = { id: string; workflowId: string; paused: boolean } & (
  | { kind: 'cron'; cron: string; timeZone: string }
  | { kind: 'event'; event: string }
  | { kind: 'webhook'; webhookId: string }
);
export interface WorkflowValidation {
  issues: { nodeId?: string; message: string }[];
}
export interface WorkflowDiff {
  workflowId: string;
  fromVersion: number;
  toVersion: number;
  changes: { nodeId: string; before?: WorkflowNode; after?: WorkflowNode }[];
}
export interface WorkflowManagementClient {
  listTemplates(): Promise<WorkflowTemplate[]>;
  previewTemplate(id: string, parameters: TemplateValues): Promise<TemplatePreview>;
  installTemplate(id: string, parameters: TemplateValues): Promise<InstalledWorkflow>;
  getDraft(id: string): Promise<InstalledWorkflow>;
  listTriggers(): Promise<WorkflowTrigger[]>;
  setTriggerPaused(id: string, paused: boolean): Promise<WorkflowTrigger>;
  validate(definition: WorkflowDefinition): Promise<WorkflowValidation>;
  diff(id: string, fromVersion: number, toVersion: number): Promise<WorkflowDiff>;
}
export class HttpWorkflowManagementClient implements WorkflowManagementClient {
  private readonly request: RequestJson;
  constructor(request: RequestJson) {
    this.request = request;
  }
  listTemplates() {
    return this.request<WorkflowTemplate[]>(root + '/templates');
  }
  previewTemplate(id: string, parameters: TemplateValues) {
    return this.request<TemplatePreview>(
      root + '/templates/' + encodeURIComponent(id) + '/preview',
      'POST',
      { parameters },
    );
  }
  installTemplate(id: string, parameters: TemplateValues) {
    return this.request<InstalledWorkflow>(
      root + '/templates/' + encodeURIComponent(id) + '/install',
      'POST',
      { parameters },
    );
  }
  getDraft(id: string) {
    return this.request<InstalledWorkflow>(root + '/drafts/' + encodeURIComponent(id));
  }
  listTriggers() {
    return this.request<WorkflowTrigger[]>(root + '/triggers');
  }
  setTriggerPaused(id: string, paused: boolean) {
    return this.request<WorkflowTrigger>(
      root + '/triggers/' + encodeURIComponent(id) + (paused ? '/pause' : '/resume'),
      'POST',
    );
  }
  validate(definition: WorkflowDefinition) {
    return this.request<WorkflowValidation>(root + '/validate', 'POST', definition);
  }
  diff(id: string, fromVersion: number, toVersion: number) {
    return this.request<WorkflowDiff>(
      root +
        '/' +
        encodeURIComponent(id) +
        '/diff?' +
        new URLSearchParams({ from: String(fromVersion), to: String(toVersion) }),
    );
  }
}
