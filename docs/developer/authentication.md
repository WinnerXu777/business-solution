# Authentication and profiles

The SDK sends both `{ bearerToken }` and `{ apiKey }` as `Authorization: Bearer <credential>`. Use a fixture bearer or host-issued session for platform, governed REST, MCP and automation. The LLM API uses its own tenant API key verifier. When a host accepts an API key on `/platform/v1/me`, `bs login` can validate and select it as a profile credential. The fixture host accepts the synthetic bearer identities.

The SDK builds governed REST envelopes from the identity returned by `/platform/v1/me`. A tenant ID in a CLI profile is an expected identity. The server resolves the effective tenant, actor, permission and scope for every call.

```powershell
$env:BS_API_KEY = '<fixture key accepted by your host>'
node packages/sdk/bin/bs.ts login --api-key-env BS_API_KEY --tenant tenant-rivetquay --profile rq
node packages/sdk/bin/bs.ts --profile rq whoami
```

Omitting `--profile` at login uses the verified tenant ID as the profile name, unless `BS_PROFILE` is set. Use explicit names to keep multiple actors for the same tenant. Profiles save the endpoint, verified tenant and credential environment variable name under `~/.config/bs/profiles.json`. Set `BS_CONFIG_FILE` to use a different file. Profile selection prefers `--profile`, then `BS_PROFILE`, then the active profile. Endpoint selection prefers `--base-url`, then `BS_BASE_URL`, then the saved URL, then the loopback default. Without a profile, the CLI checks `BS_TOKEN` followed by `BS_API_KEY`.

Set `BS_LLM_BASE_URL` and `BS_LLM_API_KEY` for an independently mounted LLM host. Set `BS_CONNECTORS_BASE_URL` and `BS_CONNECTORS_TOKEN` for a connector host with its own verified identity. A dedicated credential is scoped by that host. Without one, the SDK sends the main credential to the configured endpoint. Use trusted HTTPS hosts outside the loopback fixture environment.

`bs login --device` reports the device-flow stub status. For interactive user sessions, use the browser OIDC flow and its correlation cookie on an auth-enabled host, then supply the current access token as a bearer credential. The generated platform client exposes session refresh and logout operations. Applications using the browser login and callback routes must handle the host's cookie and redirect lifecycle. [Platform auth lifecycle](../personal-plan/platform/api.md#login-and-session-lifecycle)
