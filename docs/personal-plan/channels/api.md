# Channels API

The [channels plugin](../../../apps/api/src/channels/index.ts) owns the routes below. The application owner registers it with an instance of `Conversations`, a tenant configuration map, staff identity verification, a consent sink, and a native model client. Configure queue skills and an SLA duration for each queue. Set staff availability and skills through `Conversations.setStaff` using the tenant and staff IDs returned by verified identity. Use fictional tenants, contacts, transcripts and provider payloads for the demo.

## Browser widget

Embed the script with the tenant ID configured in the plugin.

```html
<script
  defer
  src="https://api.example/channels/widget.js"
  data-tenant="fictional-tenant-a"
></script>
```

Every widget and voice API request includes `?tenant=<tenant-id>` and the page's configured `Origin`. For same-origin browser GETs, the server also accepts the request's own origin when the browser sends `Sec-Fetch-Site: same-origin`. Configure proxy trust and the public host at bootstrap if the app terminates TLS upstream. The cross-origin preflight response permits `Authorization`, `Content-Type`, and `Last-Event-ID`. Send the signed session token as `Authorization: Bearer <token>`. Tokens bind tenant, page origin, conversation, visitor, and channel. They expire after ten minutes by default.

| Method and path                  | Input and result                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /channels/widget.js`        | Serves the dependency-free embed.                                                                                                                                                        |
| `POST /channels/widget/session`  | Creates an anonymous session and returns `token`, `conversationId`, and `expiresAt` in epoch milliseconds. Present a valid web token to renew the same visitor session.                  |
| `POST /channels/widget/messages` | Accepts JSON `{"text":"Fictional product question"}` and returns `201` with `messageId`. In bot state, the route uses the native model. A failed turn queues the conversation for staff. |
| `POST /channels/widget/events`   | Accepts `{"type":"typing","active":true}` or `{"type":"read","messageId":"..."}` and returns `204`.                                                                                      |
| `POST /channels/widget/handoff`  | Moves a bot conversation to the tenant's default queue and returns the updated summary.                                                                                                  |
| `GET /channels/widget/stream`    | Opens an authenticated SSE stream with transcript, state, SLA, typing, and read events.                                                                                                  |

SSE frames have a numeric `id`, an `event` named after the event type, and a JSON `data` object containing the same `cursor`. Resume with `Last-Event-ID` or `?after=<cursor>`. A caller can append `?once=1` for finite replay. Streams send heartbeats every 15 seconds and expire with the session used to open them. The widget reconnects with its last cursor and renews its session while the page is open. The server allows one active SSE connection per conversation and 128 per process. Per minute, the server allows 12 widget session requests and six voice session requests per tenant and IP, plus 60 web requests or 120 voice requests per visitor.

## Inbound email and SMS

| Method and path                        | Input and result                                                                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /channels/inbound/email/:tenant` | Receives SES-shaped receipt JSON from a trusted bridge. The bridge supplies lower-case hexadecimal HMAC-SHA256 of the exact request bytes in `X-Channel-Signature`. Success returns `202` with `receipts`, each containing `conversationId` and `duplicate`.                |
| `POST /channels/inbound/sms/:tenant`   | Receives Twilio-shaped form fields `MessageSid`, `From`, `To`, and `Body`. `X-Twilio-Signature` is the Base64 HMAC-SHA1 over the configured public callback URL followed by field names and decoded values in ascending name order. Success returns `200` with empty TwiML. |

The email bridge delivers an SES `Records` array whose entries have `eventSource: "aws:ses"`, `ses.mail.source`, `ses.mail.messageId`, `ses.mail.headers`, `ses.receipt.recipients`, and decoded plain text in `ses.text`. SES receipt metadata carries headers and routing. The bridge is responsible for retrieving and parsing MIME before signing the fixture delivery. The parser uses `In-Reply-To` and `References` in the same tenant, envelope sender and mailbox to find an open thread. SMS uses the sender and recipient numbers. A new inbound conversation starts in the staff queue. The configured recipient must match the delivery.

Use a distinct email bridge signing secret for each tenant and configure the SMS signature URL with the exact public path for that tenant. The service deduplicates receipt IDs per tenant and channel. STOP and its aliases write `opt_out` to the consent sink. HELP and INFO write `help_requested`. The sink receives tenant, normalized sender, recipient and receipt ID. Make writes idempotent on those fields because a retry after partial failure may revisit the sink. Successful SMS deliveries return empty TwiML.

## Voice signalling

| Method and path                | Input and result                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /channels/voice/session` | Opens a call and issues a voice bearer token with `callId`, `conversationId`, and `expiresAt`.                                                                                                                                               |
| `POST /channels/voice/signal`  | Accepts `{"type":"offer","sdp":"..."}`, `{"type":"ice","candidate":{...}}`, `{"type":"dtmf","digit":"0"}`, `{"type":"transfer"}`, or `{"type":"hangup"}`. A null ICE candidate marks the end of candidates. Successful signals return `204`. |
| `GET /channels/voice/stream`   | Returns SSE events for `answer`, `ice`, `transcript`, `dtmf`, `playback_cancelled`, `transfer`, `error`, and `ended`. Supports the same cursor and finite replay fields as the widget.                                                       |

Configure a [voice peer factory](../../../packages/adapters/src/voice/peer.ts) to negotiate the remote WebRTC leg and exchange 16 kHz PCM16 with the speech adapters. Send the offer before client ICE. The stream delivers the answer before peer ICE. The latest 512 signalling events are available for replay. The peer may send a speech-start notification for immediate playback cancellation. STT partials also cancel playback. STT finals enter the transcript and start new bot turns while the conversation is in bot state. The pipeline aborts stale turns and clears buffered audio through the peer. DTMF `0` and explicit transfer move the call into the default staff queue. Call records contain start, answer, end, digits and queue transfers. The demo uses fake WebRTC peers and speech adapters. The staff assignment updates the conversation and call record. A staffed media bridge is a separate transport integration.

## Staff routes

Staff supply a bearer credential to `verifyStaff`. That callback determines the tenant and staff IDs for every request. Claims require a staff member who is available and matches the queue's required skills. Unassigned items in the queue list include routing summaries. Claim an item to access its transcript.

| Method and path                                   | Input and result                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /channels/staff/queue`                       | Lists skill-matched queued items and the caller's assigned items. Optional `?queue=<id>` filters the list.                              |
| `GET /channels/staff/conversations/:id`           | Returns the assigned transcript, participants and voice call record when present. The resolving staff member retains transcript access. |
| `POST /channels/staff/conversations/:id/claim`    | Claims a queued conversation.                                                                                                           |
| `POST /channels/staff/conversations/:id/transfer` | Requeues the assigned conversation with JSON `{"queueId":"returns"}`. The target queue starts a fresh SLA timer.                        |
| `POST /channels/staff/conversations/:id/handback` | Returns the assigned conversation to the bot.                                                                                           |
| `POST /channels/staff/conversations/:id/resolve`  | Closes the assigned conversation and ends its active voice call.                                                                        |
| `POST /channels/staff/conversations/:id/messages` | Posts a web-chat reply with JSON `{"text":"Fictional staff reply"}`.                                                                    |
| `POST /channels/staff/conversations/:id/events`   | Posts the same typing and read forms as the widget for the assigned conversation.                                                       |

The SLA measures time from entering a queue to claim. One `sla_breached` event is recorded per queue stay. The plugin polls once per second by default and also checks the deadline when updating a conversation. Invalid sessions or signatures return `401`. A rejected origin returns `403`. Missing or inaccessible conversations return `404`, state conflicts return `409`, and rate exhaustion returns `429`.

## Model and bootstrap wiring

Create the channel model with `createNativeBotModel(client, resolveBinding)`. Resolve the service key and model alias from verified tenant scope. The key must authorize `chat.completions` in `llmPlugin`. The API test harness adapts Fastify `app.inject` to the client interface and uses the deterministic model. Anonymous channel turns send general support prompts with tool selection disabled.

The Python runtime accepts an injected `NativeModel(resolve, post)`. Run the existing graph with `build_graph(gateway, model=native_model)`, or construct `BotRuntime(BotRegistry(NATIVE_CHAT), store, gateway, model=native_model)`. The `post` callback receives the native path, headers, JSON payload, and remaining timeout in milliseconds. It returns decoded successful JSON. Explicit graph proposals still use the bounded, governed gateway. Existing fixture callers can continue to use the original graph wiring.

The in-memory repository, voice call records, SLA timer, and rate limits are process-local. A restart loses them. Web message sends lack client retry keys. Email MIME retrieval, a real WebRTC transport and a staff audio bridge need separate owner configuration and integration. The tests use in-process injection and generated audio frames without provider calls.
