import { useCallback, useState } from 'react';
import {
  Button,
  Card,
  CodeBlock,
  Drawer,
  EmptyState,
  Field,
  Input,
  StatusPill,
  Table,
  Tabs,
} from '../components.tsx';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import { canDecideApproval } from '../platform-client.ts';
import type { ApprovalState, PlatformApproval } from '../platform-client.ts';
import { formatTime } from './reporting.tsx';
import type { ScreenProps } from './screen-helpers.tsx';

const tabs = [
  ['pending', 'Pending'],
  ['approved', 'Approved'],
  ['consumed', 'Consumed'],
  ['rejected', 'Rejected'],
  ['expired', 'Expired'],
] as const;

function ApprovalDetail({
  approval,
  client,
  me,
  notify,
  onClose,
  onChange,
}: ScreenProps & {
  approval: PlatformApproval;
  onClose: () => void;
  onChange: () => void;
}) {
  const [decision, setDecision] = useState<'sign' | 'reject'>();
  const [reason, setReason] = useState('');
  const { busy, run } = useAction(notify);
  return (
    <Drawer title="Approval details" onClose={onClose} busy={busy}>
      <StatusPill status={approval.state === 'denied' ? 'rejected' : approval.state} />
      <dl className="bs-details">
        <dt>Tool</dt>
        <dd>{approval.tool}</dd>
        <dt>Target</dt>
        <dd>{approval.subjectId}</dd>
        <dt>Requested by</dt>
        <dd>{approval.requestedBy}</dd>
        <dt>Designated approver</dt>
        <dd>{approval.approverId}</dd>
        <dt>Expires (Toronto)</dt>
        <dd>{formatTime(approval.expiresAt)}</dd>
        <dt>Source version</dt>
        <dd>{approval.sourceVersion}</dd>
        <dt>Policy version</dt>
        <dd>{approval.policyVersion}</dd>
      </dl>
      <div className="bs-stack">
        <div>
          <h3>Material SHA-256</h3>
          <CodeBlock label="Material SHA-256">{approval.materialHash}</CodeBlock>
        </div>
        {'materialPreview' in approval && approval.materialPreview != null && (
          <div>
            <h3>Bound material inputs</h3>
            <CodeBlock label="Bound material inputs">
              {JSON.stringify(approval.materialPreview, null, 2)}
            </CodeBlock>
          </div>
        )}
      </div>
      {canDecideApproval(me, approval) &&
        (decision ? (
          <form
            className="bs-form bs-confirm"
            onSubmit={(event) => {
              event.preventDefault();
              if (decision === 'reject' && !reason.trim()) return;
              void run(
                () =>
                  decision === 'sign'
                    ? client.signApproval(approval.id)
                    : client.rejectApproval(approval.id, reason.trim()),
                () => {
                  notify(decision === 'sign' ? 'Approval signed.' : 'Approval rejected.');
                  onChange();
                },
              );
            }}
          >
            <h3>{decision === 'sign' ? 'Confirm signature' : 'Confirm rejection'}</h3>
            <p>
              {decision === 'sign'
                ? 'Sign the approval for these bound inputs?'
                : 'Reject the requested action?'}
            </p>
            {decision === 'reject' && (
              <Field label="Reason">
                {(props) => (
                  <Input
                    {...props}
                    required
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    disabled={busy}
                  />
                )}
              </Field>
            )}
            <div className="bs-actions">
              <Button variant="secondary" disabled={busy} onClick={() => setDecision(undefined)}>
                Back
              </Button>
              <Button
                type="submit"
                variant={decision === 'sign' ? 'primary' : 'danger'}
                disabled={busy || (decision === 'reject' && !reason.trim())}
              >
                {decision === 'sign' ? 'Confirm sign' : 'Confirm reject'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="bs-actions bs-confirm">
            <Button onClick={() => setDecision('sign')}>Sign approval</Button>
            <Button variant="danger" onClick={() => setDecision('reject')}>
              Reject approval
            </Button>
          </div>
        ))}
    </Drawer>
  );
}

export function ApprovalsScreen(props: ScreenProps) {
  const { client } = props;
  const [state, setState] = useState<ApprovalState>('pending');
  const [selected, setSelected] = useState<PlatformApproval>();
  const resource = useResource(useCallback(() => client.getApprovals(state), [client, state]));
  const content = (
    <RemoteContent resource={resource} label="approvals">
      {(rows) =>
        rows.length === 0 ? (
          <EmptyState title={'No ' + state + ' approvals.'} />
        ) : (
          <Table
            label={state + ' approvals'}
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'tool',
                title: 'Requested action',
                sortValue: (row) => row.tool,
                render: (row) => (
                  <>
                    <strong>{row.tool}</strong>
                    <small className="bs-subline">{row.subjectId}</small>
                  </>
                ),
              },
              { key: 'actor', title: 'Requested by', render: (row) => row.requestedBy },
              {
                key: 'expiry',
                title: 'Expires (Toronto)',
                sortValue: (row) => Date.parse(row.expiresAt),
                render: (row) => formatTime(row.expiresAt),
              },
              {
                key: 'action',
                title: 'Review',
                render: (row) => (
                  <Button
                    variant="secondary"
                    aria-label={'View approval ' + row.subjectId}
                    onClick={() => setSelected(row)}
                  >
                    View details
                  </Button>
                ),
              },
            ]}
          />
        )
      }
    </RemoteContent>
  );
  return (
    <Card title="Approval inbox">
      <Tabs
        label="Approval state"
        value={state}
        onChange={(id) => setState(id as ApprovalState)}
        tabs={tabs.map(([id, label]) => ({ id, label, content }))}
      />
      {selected && (
        <ApprovalDetail
          {...props}
          approval={selected}
          onClose={() => setSelected(undefined)}
          onChange={() => {
            setSelected(undefined);
            resource.reload();
          }}
        />
      )}
    </Card>
  );
}
