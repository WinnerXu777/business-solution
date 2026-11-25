CREATE TABLE governance.approval (
  tenant_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE governance.artifact (
  tenant_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE governance.intent (
  tenant_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE governance.outbox (
  tenant_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, id) REFERENCES governance.intent (tenant_id, id)
);
