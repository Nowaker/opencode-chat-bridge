# Fork deviations

This fork exists to run a personal bridge against private accounts. Upstream
is built to serve a chat room: it answers whoever can reach it, and its
defaults are chosen so a new operator sees the bot work. Those are reasonable
defaults for that purpose and the wrong ones here, where the bridge shares an
identity with its owner and sits in chats carrying their own correspondence.

Every deviation below changes a default or a behaviour that upstream chose
deliberately. Each one states what upstream does, what this fork does, and why
the change is worth the cost.

Branched from upstream `6535cc5` (v0.7.1).

## 1. Allowlists fail closed

**Upstream:** `isUserAllowed()` returns `true` when the allowlist is empty, so
an unconfigured deployment answers everyone. There is no channel-level gate at
all: a connector with credentials serves every chat it can see. Matrix declares
an `ignoreRooms` list that the Matrix connector never reads.

**This fork:** `isAllowedId()` is the single membership test and denies when the
allowlist is absent or empty. A channel allowlist sits alongside the user
allowlist, surfaced per platform as `slack.allowedChannels`,
`matrix.allowedRooms` and `whatsapp.allowedGroups`.

**Why:** a half-configured personal bridge that answers everyone is the hazard
this fork exists to remove. Failing closed makes the failure mode "the bridge
is silent", which is visible and harmless, rather than "the bridge is serving
strangers", which is neither.

**Cost:** a deployment that upgrades into this fork without adding allowlists
stops responding. Startup logging says `(none -- every channel is denied)`
rather than printing nothing, so a silent bridge is distinguishable from a
broken one.

**Notes:** matching is exact, never prefix or substring, and values are stable
platform IDs (`C...`, `!room:server`, `...@g.us`). Display names are never
matched: they are attacker-settable on all three platforms. The two gates are
independent, so passing the user check does not imply the channel check.

## 2. WhatsApp marks every outbound text `[AI] `

**Upstream:** prefixes `<botName>: `, and when a reply is long enough to split,
only the first chunk is prefixed. Tool notices use a different `<botName>: > `
shape. Each send site formats its own text.

**This fork:** every outbound text passes through one send boundary that
applies exactly `[AI] ` -- answers and each of their chunks, tool notices,
errors, permission prompts, captions.

**Why:** the bridge sends as the owner's own WhatsApp account. In a group, a
message from the bridge and a message from the human are the same sender, so
the marker is the only thing distinguishing them. A marker that holds for the
first chunk of a long answer and not the rest does not do that job.

**Notes:** this is enforced at a choke point rather than requested of the
model. An instruction to an LLM is not an enforcement mechanism. Chunking
accounts for the prefix so a marked chunk still fits WhatsApp's limit.

## 3. WhatsApp echo rejection is identity-based

**Upstream:** ignores inbound text starting with `<botName>:`.

**This fork:** ignores messages whose IDs this process emitted, falling back to
the `[AI] ` marker only for `fromMe` messages that predate a restart.

**Why:** the string test is both too weak and too strong. Another participant
can send text starting with the marker, and the human's own messages must keep
working -- `fromMe` is true for both the bridge and the owner. Neither test
consults a display name.

## 4. Tool activity is summarized against allowlists

**Upstream:** renders the ACP-supplied `description`, which is built by joining
raw argument values, and forwards whole raw tool results for any tool matching
`toolMessages.showOutputFor`.

**This fork:** chat receives a structured summary. `summaries.allowedTools`
selects which tools may show arguments at all; `summaries.allowedFields`
selects which argument names may be rendered; values are collapsed, bounded by
`maxFieldLength`, and arrays and objects render as `[n items]` / `{n fields}`.
A tool outside the allowlist is reduced to `ran <tool>` or hidden.

**Why:** anything the model passes to any tool otherwise reaches the channel --
a command line, a URL with an embedded token, a prompt body. An allowlisted
field name says the field is safe to mention, not that everything nested inside
it is safe to publish.

**Notes:** the ACP `description` is now deliberately unused, because it is
derived from the same raw arguments the allowlist exists to withhold.
`showArguments: false` is honoured by emptying the field allowlist rather than
by skipping the summarizer, so there is exactly one path from a tool call to
chat text. Both allowlists default to empty, which reveals tool names and no
argument values.

## 5. Raw tool output requires a second opt-in

**Upstream:** `showOutputFor` alone forwards raw results.

**This fork:** `safeOutput.allowRawToolOutput` must also be true. It defaults
to false.

**Why:** raw results are unbounded, unsummarized, and cannot be filtered per
field. `showOutputFor` is a presentation preference; publishing whole tool
results is a disclosure decision.

## 6. Credential shapes are masked

**Upstream:** no redaction.

**This fork:** `safeOutput.redactSecrets` masks provider tokens, JWTs, private
key blocks, `Bearer` headers, URL userinfo, and `NAME=value` where the name
announces a secret. It runs inside summarized field values and again over the
assembled message at each connector's own send chokepoint.

**Why:** a backstop behind the allowlists, not a replacement for them. A value
that is legitimately allowlisted still must not carry a token out. A tool
summary is redacted field by field, but the final assistant answer is
model-authored text that no allowlist has inspected, so the outbound edge needs
its own pass.

**Notes:**

- Redaction is idempotent, because the same text is redacted more than once on
  its way out -- `sendReply` on a non-thread Matrix room passes through
  `sendMessage`, which redacts again.
- It is applied at the chokepoint every outbound path already funnels through,
  not at the call sites that reach it, so a new send site cannot reintroduce
  the gap: `emitText`/`editText` on WhatsApp, `sendReply` plus the notice and
  tool-activity helpers on Matrix, `sendReply` plus the tool-activity and
  upload helpers on Slack.
- **Connectors below honour the flag:** WhatsApp, Matrix, Slack. Discord,
  Mattermost, Telegram and Web send their own text unredacted -- they predate
  this fork's controls and are not wired. Tool *summaries* are still safe
  everywhere, because `summarizeToolCall` redacts each field centrally.
- Inbound text is never redacted. The model needs what the human actually
  typed, and the flag governs what leaves the bridge, not what enters it.

## 7. File upload and message logging are opt-in

**Upstream:** scrapes file paths out of tool results *and* out of the model's
own prose, reads them from disk and uploads them. Writes inbound message bodies
to stdout. Neither is affected by `toolMessages`.

**This fork:** `autoUploadFiles` and `logInboundMessages` on WhatsApp, Slack
and Matrix. All default false.

**Why:** the upload path means any path the model can name is sufficient to
exfiltrate a file, and turning tool messages off does not disable it, so
suppressing tool messages alone is not an output boundary. The log path puts
the owner's own correspondence in the bridge log. On Matrix the connector must
decrypt an E2EE room to work at all, so logging the body puts into the process
log exactly what the room's encryption keeps off the wire.

**Why the upload path is not constrained by tool permissions.** This is the
part most likely to be misjudged, so it is stated explicitly rather than left
to inference. Measured on Matrix under `toolMessages.mode: "off"`,
`showOutputFor: []` and `safeOutput.allowRawToolOutput: false`, with an agent
policy denying `edit`, `write`, `bash`, `task`, `webfetch` and `websearch`,
all three upload routes still fired:

1. The model **names a path in its own answer**. No tool call occurs, so the
   agent's permission system is never consulted -- the *bridge* opens the file
   with `fs.readFileSync`. Denying every tool does not close this.
2. A path arrives **inside a tool result**. `allowRawToolOutput: false` does
   not close this either: the buffer the path is scraped from is appended to
   *before* the show/hide branch, and that branch only suppresses printing.
   The connector logs `[RESULT] Skipping read result` and then uploads the
   file named in the result it just declined to show.
3. The agent **emits image bytes inline**, which are relayed as-is.

So `autoUploadFiles` is the only thing that stops an upload. Nothing in the
agent policy, and nothing in `toolMessages` or `safeOutput`, substitutes for
it.

**Notes:**

- With logging off, each connector still records the sender, the session and a
  character count, which is what routing bugs are actually diagnosed from.
- Each connector funnels every inbound handler through one `logInbound()`
  helper rather than gating each call site, so a handler added later cannot
  quietly start printing bodies.
- `autoUploadFiles` covers a **wider** set on Matrix than elsewhere: scraped
  paths *and* inline agent image bytes. On WhatsApp and Slack it covers
  scraped paths only, and WhatsApp's inline relay is ungated. Slack has no
  inline relay at all. This divergence is deliberate -- Matrix is the deployed
  connector and the one where a room is expected to be private -- and is
  recorded at the key's declaration too. Aligning WhatsApp is an open
  decision, not an oversight.
- On Matrix the guard sits inside both functions that call `uploadContent`,
  not at their call sites, so every route is covered by construction and a
  call site added later is covered too.
- Coverage by connector, so the absences read as known rather than accidental.
  Every connector scrapes paths and uploads them; the column says whether
  anything can stop it:

  | Connector | `logInboundMessages` | `autoUploadFiles` |
  |---|---|---|
  | WhatsApp | honoured | honoured (scraped paths; inline relay ungated) |
  | Slack | honoured | honoured (scraped paths; no inline relay) |
  | Matrix | honoured | honoured (scraped paths **and** inline relay) |
  | Discord | not declared -- logs bodies | not declared -- uploads unconditionally |
  | Mattermost | not declared -- logs bodies | not declared -- uploads unconditionally |
  | Telegram | not declared -- logs bodies | not declared -- uploads unconditionally |
  | Web | not declared -- does not log bodies | not declared -- uploads unconditionally |

  Discord, Mattermost, Telegram and Web are disabled in this deployment, which
  is why they are documented rather than fixed. Enabling any of them means
  accepting unconditional uploads and, for the first three, inbound bodies in
  the log. Telegram and Web additionally upload *documents*, not only images.

## 8. Permissions round-trip to chat

**Upstream:** receives `session/request_permission`, keeps the JSON-RPC id long
enough to answer it, and immediately replies `reject`. The human is told
afterwards that something was denied, and nothing behind a permission can ever
run.

**This fork:** the request is held under a short opaque correlation token and
posted with its options numbered. It is settled only by a message that names
that token, comes from an allowlisted stable sender ID, arrives in the thread
the request was posted to, and lands inside the expiry window.

**Why:** a bridge that can only ever deny is not usable for anything gated, and
a bridge that accepts "yes" from anyone in the room is worse than one that
denies.

**Notes:**

- Ambiguous text is never an approval. A decision must be an option's 1-based
  number or its exact id or name. "yes", "ok", "sure, go ahead", a bare token,
  and a message naming two options are all refused explicitly.
- A reply in a different thread is never an approval.
- On expiry the held request is answered with its reject option and the channel
  is told. The agent is blocked on that request, so it must be answered rather
  than abandoned. The same happens on shutdown and when the ACP process exits.
- Tokens avoid `0/O/1/I/L`, and settled tokens stay briefly remembered so a
  late reply is answered with "that request is no longer open" instead of being
  forwarded to the model as a new prompt.
- The rendered prompt carries no raw arguments. The agent-supplied title is
  derived from tool input, so it is redacted and bounded like any other detail.
  Upstream's fallback of stringifying `rawInput` into the denial message is
  removed for the same reason.
- `permissions.interactive` defaults to true in configuration but false in the
  ACP client itself, so a library consumer that never answers cannot leave an
  agent blocked forever.
- The round trip is wired **per connector**, and only WhatsApp, Matrix and Slack
  have it. Holding a request without presenting it is worse than upstream's
  immediate deny -- the agent waits on a reply nobody can send, and on Matrix
  and Slack there is no query timeout to end the turn -- so the ACP client
  denies any request still held well after the configured window. Discord,
  Mattermost, Telegram and Web therefore end the turn with a delayed refusal
  rather than stalling, but cannot approve anything.
- Each connector passes its **own session key** as the thread the request
  belongs to: `chatId` on WhatsApp, `roomId:threadRootEventId` on Matrix,
  `channelId:threadTs` on Slack. The same expression settles the reply, so the
  thread check compares two ids from one namespace. Passing a bare room or
  channel id where the session key is a thread key would either refuse every
  valid reply or accept a cross-thread one.
- Reply interception runs before rate limiting and before anything that can
  start or abort a turn. Below the rate limiter an approval sent inside the
  limit window is silently dropped; below the query path it reaches the model
  as a fresh prompt.

## 9. Session workspaces can be pinned to a real project

**Upstream:** generates a workspace per connector thread, outside any git
repository, and copies `opencode.json` and `AGENTS.md` into it.

**This fork:** `acp.sessionCwd` optionally pins every session to one configured
directory. The default is unchanged.

**Why:** opencode derives a project identity by hashing the working directory.
Upstream's generated directories keep bot sessions out of the operator's own
session lists and keep threads from colliding -- that is the trade-off being
accepted knowingly when pinning is enabled. Pinned sessions do share a project
identity. In exchange the agent runs inside a real project and inherits its
`AGENTS.md`.

**Notes:** a pinned directory is the operator's project, so the bridge never
writes to it and never deletes it. Session expiry removes a generated workspace
recursively; that path returns early when pinned. Config and profile copying is
skipped. A pinned directory that does not exist is an error rather than
something to create. The path is configuration, never a literal in source.

## Not implemented, deliberately

### Reverse session discovery

Publishing a session the operator started by hand so it appears in chat is
**not implemented and will not be**. It was considered and rejected. This note
exists so the absence reads as a decision rather than an oversight; the
bridge-owned session picker (`/p`, `/s`) is a different feature and is not this.

### Interactive questions over ACP

**Questions cannot be answered over ACP. This is a property of the transport,
not a gap in this fork.**

opencode's ACP agent makes exactly three client-bound calls, declared at
`packages/opencode/src/acp/service.ts`:

```ts
type ServiceConnection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>
```

`sessionUpdate` is a notification and `writeTextFile` is a file callback, so
`requestPermission` is the only client-bound *request* -- the only place the
agent asks the client something and waits for an answer. Deviation 8 above
implements that one.

The `question` tool does not use it. `Question.Service.ask()` publishes a
`question.asked` event and awaits a deferred; the reply arrives through
opencode's HTTP API (`/question/list`, `/question/reply`, `/question/reject`)
or its own TUI. The ACP event handler in `packages/opencode/src/acp/event.ts`
switches on exactly four event types -- `session.status`, `permission.asked`,
`message.part.updated`, `message.part.delta` -- and `question.asked` is not
among them. The string `question` does not appear anywhere in opencode's `acp`
directory.

Vibeterm's `vibeterm_async_question` is built on the same question
infrastructure and is unavailable for the same reason.

Consequences, stated plainly:

- A question asked by an agent running under this bridge is **not** rendered in
  chat, because the bridge is never told about it.
- No text in chat settles a question. Displaying a question is not answering
  one, and this fork does not pretend otherwise.
- Reaching questions would require polling opencode's HTTP API alongside the
  ACP transport. That is a second control channel into another process's
  session, and it is not built here.
