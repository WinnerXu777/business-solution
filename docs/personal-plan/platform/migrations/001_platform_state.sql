CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE platform.tenant_state (
    tenant_id text NOT NULL,
    collection text NOT NULL,
    id text NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (tenant_id, collection, id)
);

CREATE FUNCTION platform.protect_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.collection = 'audit' THEN
        RAISE EXCEPTION 'Platform audit entries are append-only';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    IF NEW.collection = 'audit' THEN
        RAISE EXCEPTION 'Platform audit entries must be inserted';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_state_protect_audit
    BEFORE UPDATE OR DELETE ON platform.tenant_state
    FOR EACH ROW EXECUTE FUNCTION platform.protect_audit();
