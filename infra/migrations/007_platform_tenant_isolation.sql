-- Run after 006_record_review.sql as the migration owner.
CREATE ROLE platform_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE SEQUENCE platform.tenant_state_version AS bigint START WITH 2;

ALTER TABLE platform.tenant_state ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE platform.tenant_state
    ALTER COLUMN version SET DEFAULT nextval('platform.tenant_state_version'),
    ADD CONSTRAINT tenant_state_scope CHECK (
        tenant_id <> '' AND
        (jsonb_typeof(body) <> 'object' OR NOT (body ? 'tenantId') OR
         body ->> 'tenantId' IS NOT DISTINCT FROM tenant_id)
    );

-- Preserve existing outbox deliveries and notification read receipts.
INSERT INTO platform.tenant_state (tenant_id, collection, id, body)
SELECT state.tenant_id, 'webhook_deliveries', delivery ->> 'id', delivery
FROM platform.tenant_state AS state
CROSS JOIN LATERAL jsonb_array_elements(state.body -> 'deliveries') AS d(delivery)
WHERE state.collection = 'platform_events';

INSERT INTO platform.tenant_state (tenant_id, collection, id, body)
SELECT state.tenant_id, 'notifications',
       '[' || to_json(state.id)::text || ',' || to_json(notification ->> 'userId')::text || ']',
       notification || jsonb_build_object('eventId', state.id)
FROM platform.tenant_state AS state
CROSS JOIN LATERAL jsonb_array_elements(state.body -> 'notifications') AS n(notification)
WHERE state.collection = 'platform_events';

UPDATE platform.tenant_state AS state
SET body = (state.body - 'deliveries' - 'notifications') || jsonb_build_object(
    'notifyUserIds', COALESCE(
        (SELECT jsonb_agg(notification ->> 'userId' ORDER BY position)
         FROM jsonb_array_elements(state.body -> 'notifications') WITH ORDINALITY AS n(notification, position)),
        '[]'::jsonb
    )
)
WHERE collection = 'platform_events' AND body ? 'notifications';

CREATE UNIQUE INDEX platform_webhook_replay_once
    ON platform.tenant_state (tenant_id, (body ->> 'replayOf'))
    WHERE collection = 'webhook_deliveries' AND body ? 'replayOf';

-- Invite digests and operation keys are row IDs. The primary key enforces
-- uniqueness within (tenant_id, collection) for inserts and retries.
ALTER TABLE platform.tenant_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_state FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_tenant_scope ON platform.tenant_state
    TO platform_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE ALL ON SCHEMA platform FROM PUBLIC;
REVOKE ALL ON platform.tenant_state FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO platform_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.tenant_state TO platform_app;
GRANT USAGE ON SEQUENCE platform.tenant_state_version TO platform_app;
