CREATE TABLE runtime.llm_counters (
    tenant_id text NOT NULL,
    window_start bigint NOT NULL,
    requests bigint NOT NULL CHECK (requests >= 0),
    tokens bigint NOT NULL CHECK (tokens >= 0),
    PRIMARY KEY (tenant_id, window_start)
);

CREATE TABLE runtime.llm_reservations (
    tenant_id text NOT NULL,
    id text NOT NULL,
    window_start bigint NOT NULL,
    amount bigint NOT NULL CHECK (amount >= 0),
    expires_at bigint NOT NULL,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, window_start) REFERENCES runtime.llm_counters
);

CREATE INDEX llm_live_reservations ON runtime.llm_reservations (tenant_id, expires_at);

CREATE TABLE runtime.llm_meter_blocks (
    tenant_id text PRIMARY KEY
);

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY['llm_counters', 'llm_reservations', 'llm_meter_blocks']
    LOOP
        EXECUTE format('ALTER TABLE runtime.%I ENABLE ROW LEVEL SECURITY', name);
        EXECUTE format('ALTER TABLE runtime.%I FORCE ROW LEVEL SECURITY', name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON runtime.%I
             USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))
             WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))',
            name
        );
    END LOOP;
END $$;
