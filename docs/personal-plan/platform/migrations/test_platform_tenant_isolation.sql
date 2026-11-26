\set ON_ERROR_STOP on

-- Run with psql against a disposable migrated database as a login able to SET ROLE platform_app.
BEGIN;
SET LOCAL ROLE platform_app;

DO $$
BEGIN
    IF EXISTS (SELECT FROM platform.tenant_state) THEN
        RAISE EXCEPTION 'Unset tenant unexpectedly exposed a row';
    END IF;
    BEGIN
        INSERT INTO platform.tenant_state (tenant_id, collection, id, body)
        VALUES ('test-rivetquay', 'invites', 'synthetic-invite-digest', '{}');
        RAISE EXCEPTION 'Unset tenant unexpectedly allowed an insert';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$$;

SET LOCAL app.tenant_id = 'test-rivetquay';
INSERT INTO platform.tenant_state (tenant_id, collection, id, body)
VALUES ('test-rivetquay', 'invites', 'synthetic-invite-digest', '{"synthetic":true}');

SET LOCAL app.tenant_id = 'test-spoolharbour';
INSERT INTO platform.tenant_state (tenant_id, collection, id, body)
VALUES ('test-spoolharbour', 'invites', 'synthetic-invite-digest', '{}');

DO $$
BEGIN
    IF (SELECT count(*) FROM platform.tenant_state
        WHERE collection = 'invites' AND id = 'synthetic-invite-digest') <> 1
        OR EXISTS (SELECT FROM platform.tenant_state WHERE tenant_id = 'test-rivetquay') THEN
        RAISE EXCEPTION 'Tenant filter leaked a foreign row';
    END IF;
    UPDATE platform.tenant_state SET body = '{}' WHERE tenant_id = 'test-rivetquay';
    IF FOUND THEN RAISE EXCEPTION 'Foreign update unexpectedly matched'; END IF;
    DELETE FROM platform.tenant_state WHERE tenant_id = 'test-rivetquay';
    IF FOUND THEN RAISE EXCEPTION 'Foreign delete unexpectedly matched'; END IF;
    BEGIN
        INSERT INTO platform.tenant_state (tenant_id, collection, id, body)
        VALUES ('test-spoolharbour', 'invites', 'synthetic-invite-digest', '{}');
        RAISE EXCEPTION 'Same-tenant invite key unexpectedly duplicated';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        TRUNCATE platform.tenant_state;
        RAISE EXCEPTION 'Runtime role unexpectedly truncated tenant state';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO platform.tenant_state (tenant_id, collection, id, body)
        VALUES ('test-rivetquay', 'invites', 'second-synthetic-digest', '{}');
        RAISE EXCEPTION 'Foreign insert unexpectedly succeeded';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        UPDATE platform.tenant_state SET tenant_id = 'test-rivetquay'
        WHERE collection = 'invites' AND id = 'synthetic-invite-digest';
        RAISE EXCEPTION 'Foreign tenant reassignment unexpectedly succeeded';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE platform_app;
DO $$
BEGIN
    IF NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL THEN
        RAISE EXCEPTION 'Tenant context leaked between transactions';
    END IF;
END
$$;
ROLLBACK;
