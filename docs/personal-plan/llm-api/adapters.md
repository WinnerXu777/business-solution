# Provider adapters

## Add a model provider

1. Implement `ModelAdapter` from `packages/adapters/src/llm/index.ts`. Take a caller-supplied `HttpClient` and provider credentials or references resolved by the binding owner. The transport owns the base URL, egress allowlist, HTTP serialization and cancellation. Pass through abort signals and release the response body on iterator return.
2. Normalize chat to `Completion` and streaming to text or indexed function deltas followed by one terminal `done` with finish reason and token usage. Include input and output tokens in non-streaming results too. For a supported embeddings capability, implement `embed` with one finite vector per input in input order. Report transient unavailability, rejection, malformed responses and unsupported features as payload-free `ProviderError` codes.
3. Map function declarations, named selection, assistant call history, tool results and JSON-schema format to the wire protocol. Keep tool arguments as JSON strings in the common interface. The caller independently validates and authorizes proposals before effects.
4. Register tenant model aliases, immutable model IDs, feature and residency approvals, a route-specific prompt bound, price version and charge mode in an injected binding. The prompt bound includes provider framing, tool specifications and history. Set an inference fallback only after the tenant and binding policy approve it.
5. Add the adapter to the shared `modelContract` suite in `packages/adapters/test/llm/contract.test.ts`. Inject an in-memory fake that asserts the provider wire request and returns representative JSON and deliberately fragmented SSE.

OpenAI and native vLLM use the OpenAI-style chat and embedding paths and request stream usage. Anthropic uses Messages, including system and developer text, tool use and results, incremental arguments, input cache-token accounting and `output_config.format` for structured output. Anthropic bindings expose chat only. The deterministic fixture supports text, explicitly selected tools, configurable structured JSON and simple embeddings.

## Voice, speech and messages

| Capability     | Adapter entry point               | Transport and event shape                                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telephony      | `packages/adapters/src/voice`     | Fixture and native SIP/WebRTC placeholder share an in-memory call lifecycle. The RingCX test bridge sends start, transfer and hangup through a synthetic account-scoped bridge and parses normalized `CALL_STATUS` events. The bridge paths are local fixture endpoints.                                                       |
| Speech-to-text | `packages/adapters/src/speech`    | Fixture and native contracts consume PCM audio streams, producing segment-indexed partials and finals. The native shim uploads an audio iterable and consumes SSE from `/speech/v1/transcriptions`.                                                                                                                            |
| Text-to-speech | `packages/adapters/src/speech`    | Fixture emits PCM. The native shim lists voices and streams raw audio through `/speech/v1`. ElevenLabs maps the paginated voice catalog and streaming synthesis to the same voice and byte-chunk types. Output formats are 16 kHz signed little-endian PCM and 44.1 kHz MP3 where supported.                                   |
| Messaging      | `packages/adapters/src/messaging` | SES-shaped email and Twilio-shaped SMS implement the existing `MessageAdapter.send` seam with an explicit test mode and caller-supplied fake client. The normalized delivery receipt retains the provider ID. SES accepts notification objects or decoded SNS envelopes. Twilio accepts form fields or form-encoded callbacks. |

The existing Mailpit and simulated messaging factories remain available. Test telephony and SMS accept fictional NANP 555-01xx numbers and test email accepts reserved `.example` addresses. The test bridge and messaging transports receive relative paths. Configure them against synthetic fakes. Verify signatures and account ownership at webhook ingress before parsing, then apply tenant-scoped deduplication and reconciliation. An ambiguous messaging outcome returns `unknown` for reconciliation. Direct dispatch authority remains with the governed caller.

## Contract test checklist

- Run the shared suite against every implementation in its capability group.
- Check canonical outputs, token and status normalization, stable IDs, list ordering and supported capabilities.
- Exercise normal and streaming text, named tools, incremental JSON arguments, structured output and declared embedding support for model providers.
- Exercise early cancellation and truncated upstream SSE. Check that sanitized errors omit provider bodies and credentials.
- Assert wire paths, request fields and headers against injected fakes. Use fictional inputs and in-memory responses with zero network calls.
- Exercise malformed callbacks, partial-to-final transcription, multi-chunk audio, voice discovery and ambiguous delivery outcomes where applicable.
