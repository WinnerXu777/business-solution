# MCP integration

Connect a client with remote Streamable HTTP and custom bearer headers to the trusted platform host at `/mcp`. Use a fresh verified bearer with the tools you need. The fixture server handles JSON-RPC over POST and returns a JSON response per request. The SDK also accepts SSE POST responses and carries a session ID and negotiated protocol version when the server returns them.

In an IDE that supports HTTP MCP configuration, create a connection with type `http`, URL `http://127.0.0.1:3000/mcp` for the local fixture, and an `Authorization` header with the value `Bearer <fixture session>`. For example, use the following workspace settings structure in an IDE that accepts a `servers` map and secret input references.

```json
{
  "inputs": [
    { "type": "promptString", "id": "bs-token", "description": "Fixture bearer", "password": true }
  ],
  "servers": {
    "rivetquay": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ${input:bs-token}" }
    }
  }
}
```

For Claude Desktop, use a remote HTTP connection if your client supports both the endpoint location and its bearer header. A deployment whose client only connects via local stdio needs a trusted local stdio-to-Streamable-HTTP bridge configured with the same URL and header. The milestone supplies the HTTP endpoint and SDK helper. Check the connection by listing tools, then try `order.read` with `{"orderId":"ord-001"}`.

```ts
const inventory = await client.mcp.listTools();
console.log(inventory.tools.map(({ name }) => name));
const result = await client.mcp.call('order.read', { orderId: 'ord-001' });
```

The helper performs `initialize` and `notifications/initialized` before its first tool request. Use `listTools(nextCursor)` if the server supplies a cursor. MCP results go through the same authorization, entitlement and approval rules as REST. Keep the same caller and idempotency key if retrying a supported platform tool call.
