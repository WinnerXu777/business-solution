CREATE TABLE governance.audit (
  tenant_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, sequence)
);

CREATE FUNCTION governance.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The governance audit log is append-only';
END;
$$;

CREATE TRIGGER audit_is_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON governance.audit
FOR EACH STATEMENT EXECUTE FUNCTION governance.reject_audit_mutation();
