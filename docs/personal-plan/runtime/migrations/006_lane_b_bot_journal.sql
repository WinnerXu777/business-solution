CREATE SCHEMA IF NOT EXISTS runtime;

CREATE TABLE runtime.bot_runs (
    tenant_id text NOT NULL,
    run_id text NOT NULL,
    ordinal bigint GENERATED ALWAYS AS IDENTITY,
    session_id text,
    actor_kind text NOT NULL,
    actor_id text NOT NULL,
    body jsonb NOT NULL,
    cancel_requested boolean NOT NULL DEFAULT false,
    PRIMARY KEY (tenant_id, run_id)
);

CREATE INDEX bot_session_turns
    ON runtime.bot_runs (tenant_id, actor_kind, actor_id, session_id, ordinal);

CREATE TABLE runtime.bot_steps (
    tenant_id text NOT NULL,
    run_id text NOT NULL,
    step_id text NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (tenant_id, run_id, step_id),
    FOREIGN KEY (tenant_id, run_id) REFERENCES runtime.bot_runs ON DELETE CASCADE
);

CREATE TABLE runtime.bot_events (
    tenant_id text NOT NULL,
    run_id text NOT NULL,
    cursor integer NOT NULL CHECK (cursor > 0),
    body jsonb NOT NULL,
    PRIMARY KEY (tenant_id, run_id, cursor),
    FOREIGN KEY (tenant_id, run_id) REFERENCES runtime.bot_runs ON DELETE CASCADE
);

CREATE TABLE runtime.checkpoints (
    tenant_id text NOT NULL,
    thread_id text NOT NULL,
    namespace text NOT NULL,
    id text NOT NULL,
    parent_id text,
    checkpoint_type text NOT NULL,
    checkpoint bytea NOT NULL,
    metadata_type text NOT NULL,
    metadata bytea NOT NULL,
    PRIMARY KEY (tenant_id, thread_id, namespace, id)
);

-- LangGraph may write task output before its asynchronous checkpoint write completes.
CREATE TABLE runtime.checkpoint_writes (
    tenant_id text NOT NULL,
    thread_id text NOT NULL,
    namespace text NOT NULL,
    checkpoint_id text NOT NULL,
    task_id text NOT NULL,
    idx integer NOT NULL,
    task_path text NOT NULL,
    channel text NOT NULL,
    value_type text NOT NULL,
    value bytea NOT NULL,
    PRIMARY KEY (tenant_id, thread_id, namespace, checkpoint_id, task_id, idx)
);

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY['bot_runs', 'bot_steps', 'bot_events', 'checkpoints', 'checkpoint_writes']
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
