CREATE TABLE runtime.conversations (
    tenant_id text NOT NULL,
    id text NOT NULL,
    ordinal bigint GENERATED ALWAYS AS IDENTITY,
    body jsonb NOT NULL,
    cursor integer NOT NULL CHECK (cursor > 0),
    PRIMARY KEY (tenant_id, id)
);

-- The conversation body is the atomic snapshot of participants, messages, SSE
-- history and the current SLA assignment.
CREATE INDEX conversation_sla_due
    ON runtime.conversations (tenant_id, ((body #>> '{assignment,deadline}')::bigint))
    WHERE body->>'state' = 'queued' AND body #>> '{assignment,breachedAt}' IS NULL;

CREATE TABLE runtime.conversation_queues (
    tenant_id text NOT NULL,
    id text NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE runtime.conversation_staff (
    tenant_id text NOT NULL,
    id text NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE runtime.voice_calls (
    tenant_id text NOT NULL,
    id text NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE runtime.channel_receipts (
    tenant_id text NOT NULL,
    channel text NOT NULL CHECK (channel IN ('sms', 'email')),
    receipt_id text NOT NULL,
    conversation_id text NOT NULL,
    PRIMARY KEY (tenant_id, channel, receipt_id),
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES runtime.conversations ON DELETE CASCADE
);

CREATE TABLE runtime.connector_state (
    tenant_id text NOT NULL,
    collection text NOT NULL CHECK (collection IN ('installation', 'sync', 'webhook', 'writes')),
    id text NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (tenant_id, collection, id)
);

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY[
        'conversations', 'conversation_queues', 'conversation_staff',
        'voice_calls', 'channel_receipts', 'connector_state'
    ]
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
