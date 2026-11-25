import { useCallback } from 'react';
import {
  Button,
  Card,
  CodeBlock,
  RemoteContent,
  StatusPill,
  canReview,
  useAction,
  useResource,
  type BotRun,
  type PlatformRouteContext,
} from '@bs/ui';
import { useAutomation } from './api.ts';

export function BotRuns({ client, me, notify }: PlatformRouteContext) {
  const api = useAutomation();
  const review = canReview(me.role);
  const runs = useResource(useCallback(() => api.botRuns(), [api]));
  const approvals = useResource(
    useCallback(() => (review ? api.botApprovals() : Promise.resolve([])), [api, review]),
  );
  const action = useAction(notify);
  return (
    <div className="bs-stack">
      <Card title="Requester bot runs">
        <Button variant="secondary" onClick={runs.reload}>
          Refresh runs
        </Button>
        <RemoteContent resource={runs} label="bot runs">
          {(rows) =>
            rows.length ? (
              <ul className="bs-feature-list">
                {rows.map((run) => (
                  <li key={run.id}>
                    <strong>
                      {run.botId} v{run.version}
                    </strong>{' '}
                    <StatusPill status={run.status} />
                    <CodeBlock label="Run ID">{run.id}</CodeBlock>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No bot runs for this requester.</p>
            )
          }
        </RemoteContent>
      </Card>
      {review && (
        <Card title="Assigned bot approvals">
          <Button variant="secondary" onClick={approvals.reload}>
            Refresh approvals
          </Button>
          <RemoteContent resource={approvals} label="assigned bot approvals">
            {(rows) =>
              rows.length ? (
                rows.map(({ runId, pending }) => {
                  const { approval } = pending;
                  const material = pending.materialPreview ?? pending.draft ?? pending.previews;
                  return (
                    <form
                      key={approval.id}
                      className="bs-stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void action.run(
                          () => client.automation.resumeBot(runId, approval.id),
                          (result: BotRun) => {
                            approvals.reload();
                            notify('Bot run ' + result.status.replaceAll('_', ' ') + '.');
                          },
                        );
                      }}
                    >
                      <p>
                        {approval.tool} requested by {approval.requestedBy}
                      </p>
                      <CodeBlock label="Bound material">
                        {JSON.stringify({ runId, approval, material }, null, 2)}
                      </CodeBlock>
                      <label>
                        <input type="checkbox" required /> I reviewed the bound material.
                      </label>
                      <Button type="submit" disabled={action.busy}>
                        Approve and resume
                      </Button>
                    </form>
                  );
                })
              ) : (
                <p>No assigned bot approvals.</p>
              )
            }
          </RemoteContent>
        </Card>
      )}
    </div>
  );
}
