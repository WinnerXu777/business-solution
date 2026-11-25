# Developer documentation

The Node.js 24 SDK and `bs` CLI cover the Rivetquay fixture platform. In the monorepo, import `@bs/sdk` from a workspace that already declares it, or run the source examples below from the repository root. The package is private in this milestone.

- [Quickstart and CLI examples](quickstart.md)
- [Authentication and tenant profiles](authentication.md)
- [Idempotency and retries](idempotency.md)
- [Cursor pagination](pagination.md)
- [Errors and denial codes](errors.md)
- [Webhooks and signatures](webhooks.md)
- [MCP integration](mcp.md)
- [OpenAI-compatible LLM API and BYO routing](llm.md)
- [Runnable examples](examples/README.md)

The SDK generates governed REST tool and platform clients from the checked-in schemas. Regenerate with `pnpm --filter @bs/sdk run codegen` and verify with `pnpm --filter @bs/sdk run schema-check`. The SDK's Node test suite also runs the drift check.
