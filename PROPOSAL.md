# PROPOSAL — The next tools for @orkestrel/tool

Status: proposal for review — nothing in here is implemented. `@orkestrel/tool` 0.0.1
(workflow, workspace, agent, describe) is gated and ready; this document evaluates the
candidates for the tools that come next, ranks them, and sketches each design far enough
that a build round can start from it.

---

## 1. What was evaluated, and against what

Every candidate was evaluated against the conventions this package already established:

- **One factory per tool** — `createXxxTool(primary, options?)` returning a `ToolInterface`
  for the agent runtime, arguments validated by a contract-compiled schema in `shapers.ts`.
- **`summary` + `description`** — every tool ships the short line and the full contract, so
  the describe tool's browse-then-expand works with zero extra wiring.
- **Store slots** — stateful tools accept an optional store following the line-wide 10-rule
  standard (`get(id)`/`set(snapshot)`/`delete(id)`, upsert by `snapshot.id`, memory + database
  twins), persisting on settle, never blocking the hot path.
- **Typed errors** — tools throw `AgentToolError`; the `ToolManager` isolates the throw into
  a tool-result error the model can read and recover from.
- **Guards where recursion or contention lives** — the depth/ancestry pattern
  (`AGENT_TOOL_DEPTH`, `agentTag`/`workflowTag`) extends to any tool that can wait on
  another agent.
- **Serializable definitions, runtime function resolution** — the workflow `run`-string
  precedent: definitions stay JSON-safe; functions are supplied at construction and
  resolved by name.

### Registry survey

All five candidates are published, plus the supporting packages they lean on:

| Package               | Version | One-liner                                                                                 |
| --------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `@orkestrel/terminal` | 0.0.1   | Headless prompt broker (park-as-Promise), SSE client bridge, raw-mode TTY driver          |
| `@orkestrel/database` | 0.0.3   | One query engine over pluggable drivers; a table is a contract                            |
| `@orkestrel/server`   | 0.0.4   | Typed HTTP server; composes the `@orkestrel/router` dispatcher behind a managed lifecycle |
| `@orkestrel/reason`   | 0.0.1   | Deterministic reasoning engine: quantitative / logical / symbolic / inferential           |
| `@orkestrel/browser`  | 0.0.1   | CDP browser automation with an environment-agnostic core                                  |
| `@orkestrel/router`   | 0.0.2   | The dispatcher the server consumes                                                        |
| `@orkestrel/sse`      | 0.0.1   | The event-stream parser the terminal client uses                                          |
| `@orkestrel/console`  | 0.0.1   | Styler the terminal renders through                                                       |

Tool's dependency set today is `agent` + `workflow` + `contract` only — every adopted
candidate is a deliberate new dependency, which is one more reason to phase them.

---

## 2. Ranking at a glance

| #   | Tool                                 | Verdict                    | Why                                                                                                                                                                                                          |
| --- | ------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **terminal** → prompt + answer tools | Build first                | The broker's park-as-Promise is _exactly_ "agents wait for each other without scheduling themselves"; the missing pieces (addressing, hub, HTTP spine) are precisely tool-layer work                         |
| 2   | **database** → database tool         | Build second               | Cleanest fit: serializable criteria, contract-native schemas, fully in-memory testable, real migrate path for "make changes to them"                                                                         |
| 3   | **server** → server tool             | Build third                | Strong lifecycle surface (`start` resolves the bound port, drain, idempotent teardown); needs one design move — routes as data with the workflow `run`-string precedent — and two source verifications first |
| 4   | **reason** → reason tool             | Sleeper — ride along cheap | Not on the original list, but a deterministic scorer/judge with an audit `trace` is the perfect complement to the agent + workflow tools, and it is the most testable candidate of all                       |
| 5   | **browser** → browser tool           | Defer                      | Correct instinct: value lives in end-to-end automation against a real browser, which is environment-coupled and flaky; revisit after the others ship                                                         |

---

## 3. Priority 1 — the terminal tools (prompt + answer)

### 3.1 What `@orkestrel/terminal` gives us

The broker is the mechanism this whole use case needs:

- `createPrompt(options?)` → a headless `PromptInterface`. Each form call
  (`input`/`password`/`confirm`/`select`/`checkbox`/`editor`) **parks** a prompt and returns
  an unresolved Promise. `answer(id, value)` — from anywhere — validates and resolves it.
  `pending()` lists what's parked. Timeout → `expire` → the Promise rejects with
  `TerminalError('EXPIRE')` (default 5 minutes).
- `PendingPrompt` is already wire-safe: `{ id, form, message, options, status, time }`, with
  `serializePromptOptions` keeping declarative `ValidationRules` and dropping closures — the
  rules survive the wire and rebuild the identical validator on the far side.
- `PromptClient({ url, terminal })` bridges a remote broker's SSE stream onto any local
  `PromptFormInterface` (a real TTY via `createTerminal()`, or a programmatic implementer)
  and POSTs answers back, with replay-safe reconnect.

What it deliberately does **not** ship is the interesting part: no HTTP spine, no
multi-broker routing, no "ask _that_ terminal" addressing. That gap is not a weakness —
it is exactly the seam where the tool layer belongs.

### 3.2 Design — a hub, an ask tool, an answer tool

One new runtime entity plus two thin tools over it.

**The hub** — a named-broker registry with addressing. One broker per terminal/agent
(a mailbox each), hub-level `from`/`to` metadata, one place for the timeout policy,
the store, and the deadlock guard:

```ts
export interface PromptHubOptions {
	timeout?: number
	store?: PromptStoreInterface
	on?: PromptHubListeners
	error?: (error: unknown) => void
}

export interface AddressedPrompt extends PendingPrompt {
	readonly from: string
	readonly to: string
}

export interface PromptHubInterface {
	readonly emitter: EmitterInterface<PromptHubEventMap>
	add(name: string): void
	broker(name: string): PromptInterface | undefined
	brokers(): readonly string[]
	ask(
		from: string,
		to: string,
		form: PromptType,
		message: string,
		options?: AskOptions,
	): Promise<PromptValue>
	pending(to?: string): readonly AddressedPrompt[]
	answer(to: string, id: string, value: unknown): boolean
	remove(name: string): void
	clear(): void
	destroy(): void
}
```

`ask` parks on the target's broker (`hub.broker(to).input(...)` etc.) and returns that
broker's Promise — the caller simply awaits. `PromptValue` is the natural union
(`string` for input/password/editor/select, `boolean` for confirm,
`readonly string[]` for checkbox).

**The ask tool** — bound to the asking terminal's identity at construction:

```ts
export function createPromptTool(hub: PromptHubInterface, options: PromptToolOptions): ToolInterface

// arguments (contract-compiled)
// { to: string, form: PromptType, message: string,
//   default?, choices?, mask?, min?, max?, validate?: ValidationRules, timeout?: number }
```

The handler calls `hub.ask(options.name, args.to, args.form, args.message, ...)` and
**the tool call itself blocks until the other agent answers**. No polling, no self-scheduling,
no wake-up cron — the park-as-Promise does all of it. On expiry the tool throws
`AgentToolError` with the expire context, which the ToolManager surfaces as a readable
tool-result error ("prompt expired unanswered after 120000ms").

**The answer tool** — the receiving side, an operation union like the workspace tool:

```ts
export function createAnswerTool(hub: PromptHubInterface, options: AnswerToolOptions): ToolInterface

// arguments
// { operation: 'pending' }                                  → list prompts addressed to me
// { operation: 'answer', id: string, value: unknown }       → resolve one
```

`answer` returns the broker's boolean verdict: `false` means the value failed the prompt's
declarative validation (or the id is unknown) and the prompt stays parked — the agent gets
told and can retry, which is precisely the broker's own contract.

### 3.3 The scenario, end to end (in-process)

```ts
import { createPromptHub, createPromptTool, createAnswerTool } from '@orkestrel/tool'

const hub = createPromptHub({ timeout: 120_000 })
hub.add('planner')
hub.add('builder')

const planner = createAgent({
	provider,
	tools: [createPromptTool(hub, { name: 'planner' }), createAnswerTool(hub, { name: 'planner' })],
})
const builder = createAgent({
	provider,
	tools: [createPromptTool(hub, { name: 'builder' }), createAnswerTool(hub, { name: 'builder' })],
})
```

1. Builder hits a judgment call and invokes
   `prompt { to: 'planner', form: 'confirm', message: 'Barrel split touches the public API — proceed?' }`.
   The prompt parks on planner's broker; builder's tool call is now an awaited Promise.
2. Planner's next turn invokes `answer { operation: 'pending' }`, sees the addressed
   prompt (id, form, message, who asked), then `answer { operation: 'answer', id, value: true }`.
3. The parked Promise resolves; builder's tool call returns `true`; builder continues.
   Neither agent scheduled anything, slept, or polled.

### 3.4 Across processes and to humans

The hub's server mount is a `/server`-barrel helper that returns routes for the
`@orkestrel/router` dispatcher — SSE out, answers back in:

```ts
import { createServer, discoverPort, openStream } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'
import { createPromptHub, promptRoutes } from '@orkestrel/tool/server'

const hub = createPromptHub()
hub.add('reviewer')

const dispatcher = createDispatcher()
for (const route of promptRoutes(hub)) dispatcher.add(route)
// GET  /prompts/:name/stream     → openStream() SSE: 'pending' / 'expire' events
// POST /prompts/:name/:id        → hub.answer(name, id, body.value)

const server = createServer({ dispatcher, state: () => ({}) })
const port = await server.start()
```

A human attaches with the terminal package's own bridge, no tool code involved:

```ts
import { createTerminal, createPromptClient } from '@orkestrel/terminal/server'

const client = createPromptClient({
	url: `http://localhost:${port}/prompts/reviewer/stream`,
	terminal: createTerminal(),
})
await client.connect()
// agent questions addressed to 'reviewer' now render on this TTY; answers POST back
```

That last piece is worth pausing on: the _same_ mechanism is agent↔agent and
agent↔human. An agent asking another agent and an agent asking a person are one code
path — the only difference is what answers: an answer tool or a keyboard.

### 3.5 Deadlock, honestly

Agent runtimes block on tool calls. If A parks an ask on B while B parks an ask on A,
both are blocked until the timeout backstop fires. The hub can do better than the
backstop: on `ask(from, to)`, if `pending(from)` already holds a prompt _from_ `to`,
fail fast with `AgentToolError` — "reciprocal prompt <id> from '<to>' is parked; answer
it first". This is the depth/ancestry guard philosophy applied to waiting instead of
recursion: turn a silent deadlock into an immediate, actionable error. Timeouts remain
the backstop for everything else (an agent that died mid-conversation, a human who
walked away).

### 3.6 Store, testability, verification items

- **Store slot** — persist-on-settle like the workflow tool: an `AddressedPrompt` snapshot
  written on park, updated on answer (with the value) and on expire. Standard twins:
  `createMemoryPromptStore()` / `createDatabasePromptStore(driver)`. Honest caveat: a parked
  _Promise_ cannot survive a restart — the store gives audit and visibility, not resumption.
- **Testability** — excellent. The broker is headless and takes an injected `timer`, so
  expiry is deterministic in tests; the hub and both tools test fully in-process with no
  TTY and no HTTP. The SSE mount tests against an ephemeral `@orkestrel/server` instance.
- **Verify before building** — the broker's `answer` on an unknown id is inferred to return
  `false` (not throw); confirm in source. Confirm the exact POST body shape the
  `PromptClient` sends so `promptRoutes` matches it bit-for-bit.

---

## 4. Priority 2 — the database tool

### 4.1 Why it fits so well

`@orkestrel/database` was practically designed to be driven by an agent:

- **A table is a contract** — one `tables` declaration derives the row type, write-time
  coercion + validation, and the JSON Schema. Bad rows come back as typed
  `DatabaseError('VALIDATION')`, which maps directly onto a readable tool error.
- **`Criteria` is already serializable** — `{ conditions?, order?, limit?, offset? }` is a
  plain-JSON read spec accepted by `records`/`count`/`scan`. The query surface needs no
  translation layer at all.
- **"Make changes to them" is a real path** — `db.migrate(deployed)` diffs declared vs
  deployed schema (add/remove tables, columns, indexes) rather than hand-waving ALTERs.
- **Fully in-memory testable** — `createMemoryDriver()` runs the identical engine with zero
  I/O, and cross-backend parity is a tested invariant of the package itself, so swapping
  `createSQLiteDriver(path)` under a green test suite is low-risk.

### 4.2 The statefulness answer: a manager, exactly like workflow 0.0.4

A `DatabaseInterface` is a live handle owning an open driver — it must survive across
tool calls. This is the same problem `WorkflowManager` already solved: a registry tier
that maps `name → live handle`, backed by a store of serializable definitions, reopening
lazily. The definition snapshot is what makes reopening possible:

```ts
export interface DatabaseDefinition {
	readonly id: string
	readonly driver: 'memory' | 'json' | 'sqlite'
	readonly path?: string
	readonly tables: TableSpec
	readonly keys?: Readonly<Record<string, string>>
}

// TableSpec — the serializable column DSL the agent speaks; a helper expands it
// to real contract shapes, so ContractShape itself never has to cross the wire:
// { contacts: { columns: { id: 'string', name: 'string', age: { type: 'integer', optional: true } } } }
export type ColumnSpec = ColumnKind | { readonly type: ColumnKind; readonly optional?: boolean }
export type ColumnKind = 'string' | 'number' | 'integer' | 'boolean' | 'json'
```

`expandTables(spec)` maps kinds to `stringShape`/`integerShape`/… — a `helpers.ts`
citizen with a matching shaper, keeping the agent-facing schema small and closed while
the full contract DSL stays a consumer-land power feature.

### 4.3 The tool

```ts
export function createDatabaseTool(options?: DatabaseToolOptions): ToolInterface

export interface DatabaseToolOptions {
	name?: string
	description?: string
	store?: DatabaseDefinitionStoreInterface // definitions, not row data
	drivers?: Readonly<Record<string, () => DriverInterface>> // default: memory only
}
```

Operations (one tool, an operation union — the workspace-tool precedent):

| Operation                           | Arguments                               | Behavior                                                           |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `create`                            | `{ id, tables, driver?, path?, keys? }` | Mint definition, open handle, persist definition                   |
| `tables`                            | `{ id }`                                | List tables + JSON Schema per table (from `table.contract.schema`) |
| `add` / `set` / `update` / `remove` | `{ id, table, key?, row?/changes? }`    | Keyed writes; validation/conflict errors surface typed             |
| `get`                               | `{ id, table, key }`                    | One row or undefined                                               |
| `records` / `count`                 | `{ id, table, criteria? }`              | Serializable `Criteria` straight through                           |
| `migrate`                           | `{ id, tables }`                        | Re-declare; engine diffs and applies; returns the `Migration` plan |
| `export`                            | `{ id }`                                | Portable schema + data description                                 |
| `destroy`                           | `{ id }`                                | Close handle, delete definition                                    |

Usage:

```ts
const database = createDatabaseTool({
	store,
	drivers: { sqlite: () => createSQLiteDriver('./agents.db') },
})
const agent = createAgent({ provider, tools: [database] })

// the agent, over a few turns:
// database { operation: 'create', id: 'crm', tables: { contacts: { columns: { id: 'string', name: 'string', tier: 'string' } } } }
// database { operation: 'add', id: 'crm', table: 'contacts', row: { id: 'c1', name: 'Ada', tier: 'gold' } }
// database { operation: 'records', id: 'crm', table: 'contacts', criteria: { conditions: [{ column: 'tier', equals: 'gold' }], limit: 10 } }
// database { operation: 'migrate', id: 'crm', tables: { contacts: { columns: { ...previous, email: { type: 'string', optional: true } } } } }
```

Errors: catch `isDatabaseError(error)` and rethrow `AgentToolError` carrying the code
(`VALIDATION` / `CONFLICT` / `NOT_FOUND` / `MIGRATION` …) in context — the model reads
"row failed validation: age expects integer" and self-corrects.

**Verification item** — none blocking; the one design choice to settle at build time is
whether the manager tier lives here or upstream in `@orkestrel/database` as a
`DatabaseManager` (mirroring `WorkflowManager`). Upstream is the better long-term home;
here is the faster ship. Either satisfies the tool.

---

## 5. Priority 3 — the server tool

### 5.1 What the surface gives us

`@orkestrel/server` has a genuinely good lifecycle for programmatic control:
`start(): Promise<number>` resolves the actually-bound port; `status` walks
`idle → starting → listening → stopping → stopped`; `stop()` drains gracefully against a
deadline; `stop`/`destroy` are idempotent; restart mints a fresh stop signal. `discoverPort`
finds a free port up front (required — `start()` rejects on `EADDRINUSE`, no silent
fallback). Observability is `id`/`status`/`port` plus a typed emitter
(`response` fires `{ method, pathname, status, ms }` per request).

Two structural facts shape the tool:

1. **Routes never live on the server.** The server consumes a `@orkestrel/router`
   dispatcher and holds it read-only. Whoever owns the dispatcher owns route mutation —
   so the tool must construct and keep each server's dispatcher itself.
2. **Handlers are functions**, and functions don't serialize. The workflow package already
   solved this exact problem with `run`-strings resolved against `options.functions` at
   construction. Reuse it verbatim.

### 5.2 The tool

```ts
export function createServerTool(options?: ServerToolOptions): ToolInterface

export interface ServerToolOptions {
	name?: string
	description?: string
	store?: ServerDefinitionStoreInterface
	functions?: Readonly<Record<string, RouteHandler>> // named handlers, the run-string precedent
}

// RouteSpec — serializable; exactly one of response / handler
export interface RouteSpec {
	readonly method: string
	readonly path: string
	readonly response?: {
		readonly status?: number
		readonly headers?: Readonly<Record<string, string>>
		readonly body?: unknown
	}
	readonly handler?: string // name resolved from options.functions at mount time
}
```

Operations:

| Operation          | Arguments                       | Behavior                                                                                  |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `create`           | `{ id, routes?, host?, port? }` | Build dispatcher, mount routes, construct server (port omitted → `discoverPort` at start) |
| `start`            | `{ id }`                        | `await server.start()` → returns the bound port                                           |
| `route`            | `{ id, route }`                 | `dispatcher.add(...)` on the owned dispatcher                                             |
| `inspect`          | `{ id }`                        | `status`, `port`, route list, recent `response` events (ring buffer off the emitter)      |
| `list`             | `{}`                            | All registered servers with status + port                                                 |
| `stop` / `destroy` | `{ id }`                        | Graceful drain / terminal teardown                                                        |

Usage — an agent stubs a webhook endpoint to test another system against:

```ts
const server = createServerTool({
	functions: { echo: (request, state) => ({ status: 200, body: request.body }) },
})
const agent = createAgent({ provider, tools: [server] })

// server { operation: 'create', id: 'hook', routes: [
//   { method: 'POST', path: '/webhook', response: { status: 204 } },
//   { method: 'POST', path: '/echo', handler: 'echo' },
// ] }
// server { operation: 'start', id: 'hook' }            → 49321
// server { operation: 'inspect', id: 'hook' }          → listening, recent requests
// server { operation: 'stop', id: 'hook' }
```

Static `response` routes cover the bulk of what an agent wants (stubs, fixtures, health
endpoints, static JSON APIs over data it computed) with a fully serializable definition;
`handler` names cover the rest without ever putting a function on the wire.

**Verification items (blocking, small)** — before building: (a) whether
`dispatcher.add()` is supported while the server is listening (the `route` operation on a
running server depends on `@orkestrel/router`'s post-listen behavior — if unsupported,
`route` requires stop→mutate→start and the tool should say so in its description);
(b) `HTTPError`'s constructor signature and `discoverPort`'s exact signature, verbatim
from source. All three are one scout dispatch against the server/router repos.

---

## 6. The sleeper — the reason tool

Not on the original candidate list, but it should be: `@orkestrel/reason` is a
deterministic reasoning engine — quantitative factor scoring, logical rule chaining,
symbolic equation solving, inferential fact derivation with proof trees — where every
result carries `success`, accumulated `errors`, and a human-readable `trace`.

Why that matters here: agents are non-deterministic, and the line keeps needing
_deterministic_ judgment — acceptance gates in workflows, judge panels, scoring
candidates against a rubric. A reason tool turns "the model felt good about it" into
"rubric `release-gate` scored 0.83, trace attached", reproducibly.

```ts
export function createReasonTool(
	reason: ReasonInterface,
	options?: ReasonToolOptions,
): ToolInterface

export interface ReasonToolOptions {
	name?: string
	description?: string
	store?: DefinitionStoreInterface // reusable rubrics/rulebooks by id
}

// arguments — exactly one of definition/definitionId, exactly one of subject/subjects
// { operation: 'reason', definitionId?: string, definition?: Definition, subject?: Subject, subjects?: Subject[] }
// { operation: 'define', definition: Definition }      → validate + persist a rubric, returns its id
// { operation: 'definitions' }                          → list stored rubric ids + reasoning kinds
```

The handler is nearly trivial — `reason.validate(definition)` then
`reason.reason(subject, definition)` — because the engine is total: malformed input
yields a failure _result_ with errors, not a throw, so the model always gets something
it can read. `isDefinition`/`isSubject` gate stored and inline payloads without `as`.

Usage:

```ts
const engine = createReason({ reasoners: [createQuantitativeReasoner(), createLogicalReasoner()] })
const agent = createAgent({ provider, tools: [createReasonTool(engine, { store })] })

// reason { operation: 'define', definition: { reasoning: 'quantitative', groups: [...factors...] } }  → 'release-gate'
// reason { operation: 'reason', definitionId: 'release-gate', subject: { coverage: 0.91, breaking: 0, docs: 1 } }
// → { value: 0.83, success: true, trace: ['coverage 0.91 × weight 0.5 → …', ...] }
```

It is the cheapest candidate by far (pure, synchronous, zero I/O, zero flakiness — the
engine never touches a clock or a socket), it adds real capability the other tools
don't overlap, and it composes with them: a workflow's acceptance phase calls the reason
tool; a prompt-tool answer feeds a subject. Recommendation: ride it along with whichever
round is in flight — it will be the smallest diff of any tool in the package.

---

## 7. Browser — defer, deliberately

The instinct in the request is correct. The browser package's _core_ is admirably
testable (CDP client, context, page over an injected `CDPTransportInterface` — unit
tests can mock the transport completely), but a browser **tool**'s value is real
automation: launch, navigate, read, click. That drags in a real Chromium, timing
nondeterminism, and environment coupling — precisely the flakiness the rest of this
package has been engineered to exclude. And unlike terminal/server/database, there is no
thin-slice version that is still worth shipping: a browser tool that can't actually
browse is not a tool.

Defer it. When its turn comes, the shape is already visible: `createBrowserTool` over
the server barrel's `Browser` (discover → connect → launch) with a page registry keyed
like the server tool's handles, `operation: 'launch' | 'navigate' | 'read' | 'click' |
'screenshot' | 'close'`, unit tier against a mocked transport and an opt-in e2e tier
gated behind an environment flag. Nothing about waiting helps it; nothing about
shipping the other four first hurts it.

---

## 8. Cross-cutting decisions

**Environment split — add a `/server` barrel.** Tool today is a single `core` barrel and
environment-agnostic. The hub, prompt/answer/reason/database tools (over memory or
injected drivers) stay in core. Node-coupled pieces — `promptRoutes`, the server tool,
SQLite/JSON driver wiring — go under a new `@orkestrel/tool/server` barrel, following the
database and terminal packages' own core/server precedent. Core never imports node.

**Dependencies are phased, not bundled.** Each round adds only its own: terminal round →
`@orkestrel/terminal` (+ `server`/`router` for the `/server` barrel mount); database round →
`@orkestrel/database`; server round → `@orkestrel/server` + `@orkestrel/router`; reason →
`@orkestrel/reason`. Nothing speculative lands early (AGENTS §21).

**One error, richer context.** `AgentToolError` stays the package error. Underlying typed
errors (`TerminalError`, `DatabaseError`, `HTTPError`, `ReasonError`) are caught, and
their code + message travel in `AgentToolError`'s context so the model reads the real
reason. New codes only where a new _kind_ of failure exists — the reciprocal-prompt
guard is the one candidate ('CYCLE' fits the existing depth/ancestry family).

**Every tool ships `summary` + `description`.** The describe tool already advertises
`summary ?? description` — five new tools cost the model five short lines until it asks
for more. No MCP changes, again.

**Stores follow the 10-rule standard, twins included.** Prompt snapshots, database
definitions, server definitions, reason definitions: each gets
`createMemoryXxxStore()` / `createDatabaseXxxStore(driver)` and an `isXxxSnapshot` guard.
Live handles (open databases, listening servers, parked Promises) are never stored —
definitions are, and managers reopen lazily. That line — _store definitions, re-mint
handles_ — is the single sentence that answers every statefulness question above.

---

## 9. Recommended roadmap

1. **Publish `@orkestrel/tool` 0.0.1 now.** It is gated, reviewed, and its four tools are
   complete. Holding a verified release hostage to future tools inverts §21 — ship what
   exists, add what's next.
2. **0.0.2 — terminal round**: `createPromptHub`, `createPromptTool`, `createAnswerTool`,
   prompt store twins, `/server` barrel with `promptRoutes`. Pre-work: the two terminal
   verification items (one scout dispatch).
3. **0.0.3 — database round**: `createDatabaseTool`, `TableSpec`/`expandTables`,
   definition store twins. Decide manager placement (tool vs upstream) at plan time.
4. **0.0.4 — server round**: `createServerTool`, `RouteSpec` + `functions` resolution,
   definition store twins. Pre-work: the router post-listen verification items.
5. **Reason rides along** with whichever round has room — smallest diff, zero flakiness,
   immediate composition value with workflow acceptance gates.
6. **Browser waits** until the four are shipped and an opt-in e2e lane exists.

Each round is one build/review/verify cycle in the shape this project already runs:
scout the verification items, plan the unit, build, checker + reviewer, verifier sweep,
publish.
