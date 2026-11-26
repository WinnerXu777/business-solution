CREATE TABLE governance.event_outbox (
  tenant_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
