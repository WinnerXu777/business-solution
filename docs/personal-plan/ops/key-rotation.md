# Key rotation

1. Identify the affected fixture tenant, credential reference and provider binding. List pending or held actions that use the binding and pause the applicable fixture dispatch route if its credential may be unavailable.
2. Authenticate as the fixture tenant admin. Use the Providers UI or `POST /platform/v1/credentials/:ref/rotate` with a newly invented test secret. Keep the secret out of shell history, logs, tickets and screenshots.
3. Verify the binding still points to the expected credential reference and that the version increased. Exercise the adapter with the local fake and check the redacted audit entries. Resume the paused fixture route once the test succeeds.
4. Record the tenant, credential reference, change time and verification result. If the rotation is unsuccessful, leave the route paused and create a replacement test binding or rotate the credential again.
5. Treat `BS_PLATFORM_VAULT_MASTER_KEY` as a database recovery dependency. Keep the version used by durable ciphertext available to the approved operator for restore. The demo has no in-place master-key re-encryption workflow. For master-key replacement, initialize a fresh isolated demo database with a new key and recreate synthetic bindings under it.
