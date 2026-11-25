CREATE TABLE governance.outcome (
  tenant_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE governance.usage (
  tenant_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
