import type { Readable, Writable } from 'node:stream'
import type { ReasonDefinition, ReasonInterface } from '@orkestrel/reason'
import type { FileInterface, FileSystemError, FileSystemInterface } from '@orkestrel/filesystem'
import type { InterpretInterface, InterpretTemplate } from '@orkestrel/interpret'
import type { AgentManagerInterface } from '@orkestrel/agent'
import type { SandboxInterface } from '@orkestrel/sandbox'
import type { TerminalFormInterface } from '@orkestrel/terminal'
import type { TemplateManagerInterface, TemplateInterface } from '@orkestrel/prompt'
import type {
	TaskInterface,
	TaskResult,
	WorkflowInterface,
	WorkflowsManagerInterface,
} from '@orkestrel/workflow'
import type { ToolInterface } from '@orkestrel/core'

// === MCP Server Options

/**
 * Configuration for creating an MCP server.
 *
 * @remarks
 * - `name` — server name reported during `initialize`
 * - `version` — server version reported during `initialize`
 * - `tools` — tool instances to expose over the protocol
 * - `description` — optional server-level description; combined with each
 *   tool's `description` to form the `instructions` field in the
 *   `initialize` response for LLM guidance
 */
export interface MCPServerOptions {
	readonly name: string
	readonly version: string
	readonly tools: readonly ToolInterface[]
	readonly description?: string
	readonly transport?: TransportInterface
}

// === JSON-RPC

/**
 * JSON-RPC 2.0 request object.
 *
 * @remarks
 * `id` is absent for notifications.
 */
export interface JsonRpcRequest {
	readonly jsonrpc: '2.0'
	readonly method: string
	readonly id?: string | number
	readonly params?: Record<string, unknown>
}

/** JSON-RPC 2.0 error data */
export interface JsonRpcErrorData {
	readonly code: number
	readonly message: string
	readonly data?: unknown
}

/** JSON-RPC 2.0 response object */
export interface JsonRpcResponse {
	readonly jsonrpc: '2.0'
	readonly id: string | number | null
	readonly result?: unknown
	readonly error?: JsonRpcErrorData
}

/** Unified JSON-RPC 2.0 message — either a request/notification or a response */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse

// === Transport

/**
 * Options for sending a message through a transport.
 *
 * @remarks
 * - `requestId` — the request id this response correlates to (routing)
 * - `token` — resumption token (reserved for future resumability)
 */
export interface TransportSendOptions {
	readonly requestId?: string | number
	readonly token?: string
}

/**
 * Wire-protocol abstraction for MCP server and client communication.
 *
 * @remarks
 * A transport handles the low-level details of sending and receiving
 * JSON-RPC messages. The server/client delegate all I/O to the transport
 * and never touch the wire format directly.
 *
 * Implementations: `StdioTransport`, `HTTPServerTransport`,
 * `HTTPClientTransport`, `WebSocketServerTransport`, `WebSocketClientTransport`.
 *
 * Lifecycle: `start()` → exchange messages via `send()`/`onMessage` → `close()`.
 */
export interface TransportInterface {
	readonly sessionId: string | undefined
	start(): Promise<void>
	send(message: JsonRpcMessage | JsonRpcMessage[], options?: TransportSendOptions): Promise<void>
	close(): Promise<void>
	onMessage?: (message: JsonRpcMessage) => void
	onClose?: () => void
	onError?: (error: Error) => void
}

/**
 * Configuration for creating a stdio transport.
 *
 * @remarks
 * - `stdin` — readable stream to read from (defaults to `process.stdin`)
 * - `stdout` — writable stream to write to (defaults to `process.stdout`)
 */
export interface StdioTransportOptions {
	readonly stdin?: Readable
	readonly stdout?: Writable
}

/**
 * Configuration for creating an HTTP server transport (Streamable HTTP).
 *
 * @remarks
 * - `sessionId` — function that generates session IDs; omit for stateless mode
 * - `streaming` — when true (default), responses use SSE; when false, JSON
 * - `hosts` — allowed `Host` header values for DNS rebinding protection
 * - `origins` — allowed `Origin` header values for DNS rebinding protection
 * - `versions` — supported MCP protocol versions
 * - `events` — event store for SSE resumability; when provided, enables event replay
 */
export interface HTTPServerTransportOptions {
	readonly sessionId?: () => string
	readonly streaming?: boolean
	readonly hosts?: readonly string[]
	readonly origins?: readonly string[]
	readonly versions?: readonly string[]
	readonly events?: EventStoreInterface
}

/**
 * Extended transport interface for HTTP server transports.
 *
 * @remarks
 * Adds `handle(request)` for routing incoming HTTP requests
 * (GET, POST, DELETE) through the MCP Streamable HTTP protocol.
 */
export interface HTTPServerTransportInterface extends TransportInterface {
	handle(request: Request): Promise<Response>
}

/**
 * Reconnection configuration for client transports.
 *
 * @remarks
 * - `delay` — initial delay in milliseconds before first retry
 * - `ceiling` — maximum delay in milliseconds
 * - `factor` — multiplicative growth factor per retry
 * - `retries` — maximum number of reconnection attempts
 */
export interface ReconnectionOptions {
	readonly delay: number
	readonly ceiling: number
	readonly factor: number
	readonly retries: number
}

/**
 * Configuration for creating an HTTP client transport (Streamable HTTP).
 *
 * @remarks
 * - `url` — MCP server endpoint URL
 * - `sessionId` — initial session ID (captured from server on connect)
 * - `headers` — callback returning custom headers (auth tokens, API keys)
 * - `reconnection` — exponential backoff configuration for SSE reconnects
 */
export interface HTTPClientTransportOptions {
	readonly url: string
	readonly sessionId?: string
	readonly headers?: () => Record<string, string> | Promise<Record<string, string>>
	readonly reconnection?: ReconnectionOptions
}

/**
 * Configuration for creating a WebSocket client transport.
 *
 * @remarks
 * - `url` — WebSocket server URL (ws:// or wss://)
 */
export interface WebSocketClientTransportOptions {
	readonly url: string
}

// === EventStore

/** A stored SSE event for resumability replay. */
export interface EventStoreEntry {
	/** Monotonic event ID (string token) */
	readonly id: string
	/** The JSON-RPC message */
	readonly message: JsonRpcMessage
	/** Unix timestamp when the event was stored */
	readonly timestamp: number
}

/** Configuration for creating an EventStore. */
export interface EventStoreOptions {
	/** Maximum number of events to retain (default: 1000) */
	readonly capacity?: number
	/** Maximum age in milliseconds before eviction (default: 300_000 = 5 min) */
	readonly ttl?: number
}

/**
 * In-memory event store for SSE resumability.
 *
 * @remarks
 * Stores SSE events keyed by monotonic ID. Supports replay from
 * a given ID and automatic eviction by capacity and TTL.
 */
export interface EventStoreInterface {
	/** Current number of stored events */
	readonly count: number

	/**
	 * Append an event and return its assigned ID.
	 *
	 * @param message - the JSON-RPC message to store
	 * @returns the assigned event ID (monotonic string token)
	 */
	append(message: JsonRpcMessage): string

	/**
	 * Replay events after the given ID.
	 *
	 * @param afterId - the last event ID the client received
	 * @returns events after that ID, in order
	 */
	replay(afterId: string): readonly EventStoreEntry[]

	/**
	 * Get a single event by ID.
	 *
	 * @param id - the event ID
	 * @returns the entry, or undefined if evicted or not found
	 */
	entry(id: string): EventStoreEntry | undefined

	/** Remove all stored events. */
	clear(): void
}

// === WebSocket Compatibility

/**
 * Minimal WebSocket-like interface for server-side transport.
 *
 * @remarks
 * Satisfied by both the browser `WebSocket` global and
 * `NodeWebSocketInterface` from the server package.
 * Only the subset needed by `WebSocketServerTransport` is declared.
 */
export interface WebSocketLike {
	onmessage: ((event: { readonly data: string }) => void) | null
	onclose: (() => void) | null
	onerror: ((event: unknown) => void) | null
	send(data: string): void
	close(): void
}

// === MCP Server Interface

/**
 * MCP server interface for exposing tools over the Model Context Protocol.
 *
 * @remarks
 * `handle` processes a single JSON-RPC message and returns the response.
 * Returns `undefined` for notifications (no response expected).
 * `start` begins listening on stdin/stdout.
 * `stop` terminates the server.
 */
export interface MCPServerInterface {
	readonly name: string
	readonly version: string
	readonly transport: TransportInterface
	handle(message: string): Promise<JsonRpcResponse | undefined>
	start(): void
	stop(): void
}

// === MCP Store

/**
 * Result of loading definitions from a store.
 *
 * @remarks
 * Contains the successfully loaded definitions and trace messages
 * for debugging (loaded files, skipped files, errors).
 */
export interface MCPStoreLoadResult {
	readonly definitions: readonly MCPStoreEntry[]
	readonly trace: readonly string[]
}

/**
 * A single entry in an MCP store.
 *
 * @remarks
 * Wraps the raw definition data with its id for identification.
 * The `data` field contains the serializable definition payload.
 */
export interface MCPStoreEntry {
	readonly id: string
	readonly data: Record<string, unknown>
}

/**
 * Configuration for creating an MCP store.
 *
 * @remarks
 * - `path` — absolute directory path for the store
 * - `writable` — whether the store supports write/remove operations (default: true)
 *
 * Read-only stores are useful for definition directories that should not be
 * modified at runtime (e.g. bundled definition templates).
 */
export interface MCPStoreOptions {
	readonly path: string
	readonly writable?: boolean
}

/**
 * File-system-backed store for persisting and loading definitions.
 *
 * @remarks
 * Each store maps to a single directory on disk.
 * `load` scans the directory and returns all valid entries.
 * `write` persists an entry as a JSON file (writable stores only).
 *
 * Follows the batch operation pattern for `remove`:
 * - `remove()` — removes ALL entries, returns void
 * - `remove(id)` — removes ONE entry, returns boolean
 *
 * `entries` returns the in-memory snapshot after the last `load`.
 * Call `load` to refresh from disk.
 */
export interface MCPStoreInterface {
	readonly id: string
	readonly path: string
	readonly writable: boolean
	load(): Promise<MCPStoreLoadResult>
	write(entry: MCPStoreEntry): Promise<void>
	entry(id: string): MCPStoreEntry | undefined
	entries(): readonly MCPStoreEntry[]
	remove(): Promise<void>
	remove(id: string): Promise<boolean>
}

/**
 * Manages a collection of MCP stores for centralized definition storage.
 *
 * @remarks
 * Provides a unified view across multiple stores. `load` loads all stores
 * and merges entries — later stores overwrite earlier ones on id collision.
 * `entries` returns the merged snapshot.
 *
 * `write` and `remove` delegate to the first writable store.
 * Use `store(id)` to target a specific store for write/remove.
 *
 * Follows the batch operation pattern for `remove`:
 * - `remove(id)` → boolean (removes ONE store)
 * - `remove(ids[])` → boolean (removes LISTED stores, true if all succeed)
 * - `clear()` → void (removes ALL stores)
 *
 * Follows the manager accessor pattern:
 * - `store(id)` → one or undefined
 * - `stores()` → all in order
 */
export interface MCPStoreManagerInterface {
	readonly count: number
	create(options: MCPStoreOptions): MCPStoreInterface
	store(id: string): MCPStoreInterface | undefined
	stores(): readonly MCPStoreInterface[]
	load(): Promise<void>
	write(entry: MCPStoreEntry): Promise<void>
	entry(id: string): MCPStoreEntry | undefined
	entries(): readonly MCPStoreEntry[]
	remove(id: string): Promise<boolean>
	remove(ids: string[]): Promise<boolean>
	clear(): void
}

// === Reason Tool

/**
 * Input for creating a reasoning tool via factory function.
 *
 * @remarks
 * - `name` — tool name exposed to the model
 * - `description` — natural-language description the model sees
 * - `reason` — the reason instance that performs computation
 * - `definitions` — optional pre-loaded definitions referenced by id
 * - `memory` — default for per-call memory (store inline defs after execute)
 * - `stores` — store manager for persist/folder features (Node only)
 *
 * Does NOT extend `ToolInput` because ReasonTool overrides `execute`
 * entirely — it has no external handler. The parameters are provided
 * by `TOOL_PARAMETERS`.
 */
export interface ReasonToolInput {
	readonly name: string
	readonly summary: string
	readonly description: string
	readonly reason: ReasonInterface
	readonly definitions?: readonly ReasonDefinition[]
	readonly memory?: boolean
	readonly stores?: MCPStoreManagerInterface
}

/**
 * Standard tool interface for agent integration.
 *
 * @remarks
 * Produced by `createReasonTool`. The model invokes `execute` with a record
 * containing `definitionId` or `definition` and `subject` or `subjects`.
 * Works standalone — call `execute` directly without an agent.
 *
 * Call `init()` after construction to load definition files from
 * configured stores. Calling `init()` is optional if only in-memory
 * definitions are used.
 *
 * Follows the batch operation pattern for `execute`:
 * - `execute({ subject })` → `ReasonResult` (one subject)
 * - `execute({ subjects })` → `readonly ReasonResult[]` (multiple subjects)
 *
 * Follows the batch operation pattern for `forget`:
 * - `forget()` — removes ALL stored definitions, returns void
 * - `forget(id)` — removes ONE stored definition by id, returns boolean
 */
export interface ReasonToolInterface extends ToolInterface {
	readonly stores: MCPStoreManagerInterface | undefined
	init(): Promise<void>
	import(path: string): Promise<ImportResult>
	definitions(): ReadonlyMap<string, ReasonDefinition>
	list(): readonly { readonly id: string; readonly name: string; readonly type: string }[]
	forget(): void
	forget(id: string): boolean
}

/** Result of a forget management operation */
export interface ForgetResult {
	readonly success: boolean
	readonly message: string
}

/** Result of importing a definition file */
export interface ImportResult {
	readonly success: boolean
	readonly message: string
	readonly id: string | undefined
}

// === MCP Batch Request

/**
 * A single request within a client batch call.
 *
 * @remarks
 * - `method` — the JSON-RPC method name
 * - `params` — optional parameters for the method
 */
export interface MCPBatchRequest {
	readonly method: string
	readonly params?: Record<string, unknown>
}

// === MCP Client Options

/**
 * Configuration for creating an MCP client.
 *
 * @remarks
 * `url` is the Streamable HTTP endpoint of the MCP server.
 * `name` and `version` identify this client during the `initialize` handshake
 * (defaults to `"atelier"` / `"0.0.1"`).
 * `timeout` sets the request timeout in milliseconds
 * (defaults to `DEFAULT_TIMEOUT_MS`).
 */
export interface MCPClientOptions {
	readonly url: string
	readonly name?: string
	readonly version?: string
	readonly timeout?: number
	readonly transport?: TransportInterface
}

/**
 * MCP client for connecting to Model Context Protocol servers
 * via the Streamable HTTP transport.
 *
 * @remarks
 * `connect()` performs the JSON-RPC `initialize` handshake and stores
 * the session ID returned by the server.
 * `disconnect()` tears down the session.
 * `tools()` sends a `tools/list` request and returns `ToolInterface`
 * instances whose `execute` method calls `tools/call` on the server.
 * `batch()` sends multiple JSON-RPC requests in a single transport call
 * and returns results in request order.
 *
 * The client must be connected before calling `tools()` or `batch()`.
 */
export interface MCPClientInterface {
	readonly url: string
	readonly connected: boolean
	readonly transport: TransportInterface
	connect(): Promise<void>
	disconnect(): Promise<void>
	tools(): Promise<readonly ToolInterface[]>

	/**
	 * Send multiple JSON-RPC requests in a single transport call.
	 *
	 * @param requests - array of `{ method, params }` objects
	 * @returns array of results in request order
	 */
	batch(requests: MCPBatchRequest[]): Promise<readonly unknown[]>
}

// === FileSystem Tool

/**
 * Input for creating a filesystem tool.
 *
 * @remarks
 * `name`        — tool name exposed to the model.
 * `description` — natural-language description the model sees.
 * `filesystem`  — the `FileSystemInterface` instance to wrap.
 * `stores`      — optional store manager for snapshot persistence.
 *                 When provided, snapshots are saved to disk and loaded
 *                 on `init()` so work survives session loss.
 */
export interface FileSystemToolInput {
	readonly name: string
	readonly summary: string
	readonly description: string
	readonly filesystem: FileSystemInterface
	readonly stores?: MCPStoreManagerInterface
}

/**
 * Discriminated set of operations the tool dispatches to the filesystem.
 *
 * @remarks
 * Sent by the model as the `operation` field in `execute()` arguments.
 */
export type FileSystemOperation =
	| 'scan'
	| 'stat'
	| 'search'
	| 'replace'
	| 'open'
	| 'read'
	| 'write'
	| 'prepend'
	| 'append'
	| 'remove'
	| 'move'
	| 'list'
	| 'revert'
	| 'persist'
	| 'snapshot'
	| 'restore'

/**
 * Return value from `FileSystemToolInterface.execute()`.
 *
 * @remarks
 * `operation` — the operation that was dispatched.
 * `ok`        — whether the operation succeeded.
 * `output`    — operation-specific payload.
 * `error`     — populated when `ok` is `false`.
 * `duration`  — wall-clock time for the operation in milliseconds.
 */
export interface FileSystemToolResult {
	readonly operation: FileSystemOperation
	readonly ok: boolean
	readonly output: unknown
	readonly error: FileSystemError | undefined
	readonly duration: number
}

/**
 * Standard tool wrapper for a `FileSystemInterface`.
 *
 * @remarks
 * Exposes all filesystem operations as a single `execute()` call that an
 * agent or MCP client can invoke. The model sends `{ operation, ...args }`
 * and the tool routes to the correct method.
 */
export interface FileSystemToolInterface extends ToolInterface {
	readonly stores: MCPStoreManagerInterface | undefined
	init(): Promise<void>
	execute(args: Record<string, unknown>): Promise<FileSystemToolResult>
	files(): ReadonlyMap<string, FileInterface>
	list(): {
		readonly files: readonly Record<string, unknown>[]
		readonly snapshots: readonly string[]
	}
	snapshots(): readonly string[]
	forget(): void
	forget(path: string): boolean
}

// === Interpret Tool

/**
 * Input for creating an interpret tool.
 *
 * @remarks
 * `name`        — Tool name exposed to the model.
 * `description` — Natural-language description the model sees.
 * `interpreter` — The interpret instance for processing.
 * `templates`   — Optional pre-loaded templates registered at construction.
 * `memory`      — When true, templates from `interpret` results are cached in-memory.
 * `stores`      — Store manager for persisting templates to disk.
 */
export interface InterpretToolInput {
	readonly name: string
	readonly summary: string
	readonly description: string
	readonly interpreter: InterpretInterface
	readonly templates?: readonly InterpretTemplate[]
	readonly memory?: boolean
	readonly stores?: MCPStoreManagerInterface
}

/**
 * Standard tool wrapper for the interpret pipeline.
 *
 * @remarks
 * Exposes interpretation as a single `execute` call that an agent
 * or MCP client can invoke.
 */
export interface InterpretToolInterface extends ToolInterface {
	init(): Promise<void>
	templates(): ReadonlyMap<string, InterpretTemplate>
	list(): readonly { readonly id: string; readonly name: string; readonly domain: string }[]
	readonly stores: MCPStoreManagerInterface | undefined
	import(path: string): Promise<ImportResult>
	forget(): void
	forget(id: string): boolean
}

// === Agent Tool

/**
 * Input for creating an agent tool.
 *
 * @remarks
 * `name`        — Tool name exposed to the model.
 * `summary`     — Short summary for tool listings.
 * `description` — Natural-language description the model sees.
 * `manager`     — The `AgentManagerInterface` that creates child agents.
 * `tools`       — Optional tools to provide to child agents.
 * `url`         — Ollama server URL for model listing and per-request provider creation.
 * `timeout`     — Default timeout in ms for per-request provider creation.
 *
 * The AgentTool wraps an agent as a tool, enabling sub-agent orchestration.
 * When the model calls this tool, it creates a child agent, sends the
 * task description as a prompt, and returns the response.
 */
export interface AgentToolInput {
	readonly name: string
	readonly summary: string
	readonly description: string
	readonly manager: AgentManagerInterface
	readonly tools?: readonly ToolInterface[]
	readonly url?: string
	readonly timeout?: number
}

/**
 * Standard tool wrapper for an agent, enabling sub-agent orchestration.
 *
 * @remarks
 * When invoked, creates a child agent, sends the task as a user message,
 * and returns the generated response. Supports streaming mode.
 *
 * The model sends `{ task, system?, stream? }` and receives the agent's
 * response as a string.
 */
export interface AgentToolInterface extends ToolInterface {
	/** The agent manager backing this tool */
	readonly manager: AgentManagerInterface
}

// === Sandbox Tool

/**
 * Input for creating a sandbox tool.
 *
 * @remarks
 * `name`        — Tool name exposed to the model.
 * `summary`     — Short summary for tool listings.
 * `description` — Natural-language description the model sees.
 * `sandbox`     — Optional pre-created sandbox to wrap. When omitted,
 *                 the tool creates sandboxes on demand via `create`.
 */
export interface SandboxToolInput {
	readonly name: string
	readonly summary: string
	readonly description: string
	readonly sandbox?: SandboxInterface
}

/**
 * Discriminated set of operations the sandbox tool dispatches.
 *
 * @remarks
 * Sent by the model as the `operation` field in `execute()` arguments.
 */
export type SandboxOperation =
	| 'create'
	| 'write'
	| 'read'
	| 'scan'
	| 'entries'
	| 'ensure'
	| 'remove'
	| 'stat'
	| 'has'
	| 'execute'
	| 'destroy'
	| 'list'

/**
 * Return value from `SandboxToolInterface.execute()`.
 *
 * @remarks
 * `operation` — the operation that was dispatched.
 * `ok`        — whether the operation succeeded.
 * `output`    — operation-specific payload.
 * `error`     — populated when `ok` is `false`.
 * `duration`  — wall-clock time for the operation in milliseconds.
 */
export interface SandboxToolResult {
	readonly operation: SandboxOperation
	readonly ok: boolean
	readonly output: unknown
	readonly error: string | undefined
	readonly duration: number
}

/**
 * Standard tool wrapper for on-disk sandbox operations.
 *
 * @remarks
 * Manages one or more isolated temporary directories with path-guarded
 * file operations. The model sends `{ operation, ...args }` and the tool
 * routes to the correct sandbox method.
 *
 * Supports multiple concurrent sandboxes via `create` / `cleanup`.
 * `sandbox(id)` looks up ONE sandbox by id; `sandboxes()` lists ALL.
 */
export interface SandboxToolInterface extends ToolInterface {
	execute(args: Record<string, unknown>): Promise<SandboxToolResult>
	sandbox(id: string): SandboxInterface | undefined
	sandboxes(): ReadonlyMap<string, SandboxInterface>
	destroy(): void
}

// === Prompt Tool

/**
 * Remote prompt bridge configuration for the prompt tool.
 *
 * @remarks
 * Provides the prompt tool with awareness of the remote prompt
 * companion's connection state and the ability to launch it.
 *
 * `port`      — HTTP server port for the SSE bridge.
 * `token`     — Authentication token for the companion.
 * `script`    — Absolute path to the prompt companion script or SEA executable.
 * `sealed`    — When true, the script is a SEA executable (no `node` prefix needed).
 * `connected` — Returns whether a companion is currently connected.
 * `launch`    — Spawns the companion in a new terminal. Returns true on success.
 */
export interface PromptToolRemote {
	readonly port: number
	readonly token: string
	readonly script: string
	readonly sealed: boolean
	readonly connected: () => boolean
	readonly launch: () => boolean
}

/**
 * Input for creating a prompt tool.
 *
 * @remarks
 * `name`        — Tool name exposed to the model.
 * `summary`     — Short summary for tool listings.
 * `description` — Natural-language description the model sees.
 * `terminal`    — The terminal form interface for interactive input.
 * `templates`   — Optional template manager for prompt templates.
 * `stores`      — Optional store manager for persisting prompt templates to disk.
 * `remote`      — Optional remote prompt bridge for companion launch/status.
 */
export interface PromptToolInput {
	readonly name: string
	readonly summary: string
	readonly description: string
	readonly terminal: TerminalFormInterface
	readonly templates?: TemplateManagerInterface
	readonly stores?: MCPStoreManagerInterface
	readonly remote?: PromptToolRemote
}

/**
 * Discriminated set of operations the prompt tool dispatches.
 *
 * @remarks
 * Sent by the model as the `operation` field in `execute()` arguments.
 */
export type PromptOperation =
	| 'input'
	| 'password'
	| 'confirm'
	| 'select'
	| 'checkbox'
	| 'editor'
	| 'form'
	| 'register'
	| 'fill'
	| 'validate'
	| 'templates'
	| 'remove'
	| 'launch'
	| 'status'

/**
 * Return value from `PromptToolInterface.execute()`.
 *
 * @remarks
 * `operation` — the operation that was dispatched.
 * `ok`        — whether the operation succeeded.
 * `output`    — operation-specific payload.
 * `error`     — populated when `ok` is `false`.
 * `duration`  — wall-clock time for the operation in milliseconds.
 */
export interface PromptToolResult {
	readonly operation: PromptOperation
	readonly ok: boolean
	readonly output: unknown
	readonly error: string | undefined
	readonly duration: number
}

/**
 * Standard tool wrapper for interactive terminal prompts and templates.
 *
 * @remarks
 * Exposes prompt operations (input, password, confirm, select, checkbox,
 * editor) and template management (register, fill, validate, templates,
 * remove) as a single `execute()` call that an agent or MCP client
 * can invoke.
 *
 * Follows the manager accessor pattern for templates:
 * - `template(id)` → one or undefined
 * - `templates()` → all registered
 *
 * When `stores` is provided, templates can be persisted to disk and
 * loaded on `init()`.
 */
export interface PromptToolInterface extends ToolInterface {
	readonly stores: MCPStoreManagerInterface | undefined
	execute(args: Record<string, unknown>): Promise<PromptToolResult>
	init(): Promise<void>
	template(id: string): TemplateInterface | undefined
	templates(): readonly TemplateInterface[]
	forget(): void
	forget(id: string): boolean
}

// === Workflow Tool

/**
 * Input for creating a workflow tool.
 *
 * @remarks
 * `name`        — Tool name exposed to the model.
 * `summary`     — Short summary for tool listings.
 * `description` — Natural-language description the model sees.
 * `manager`     — The `WorkflowsManagerInterface` that owns workflows.
 * `stores`      — Optional store manager for snapshot persistence.
 *                 When provided, snapshots are saved to disk and loaded
 *                 on `init()` so workflows survive session loss.
 * `onBlocked`   — Optional callback fired when any task transitions to
 *                 `blocked` status. Receives the task result and the task
 *                 itself so the handler can prompt the user and unblock.
 */
export interface WorkflowToolInput {
	readonly name: string
	readonly summary: string
	readonly description: string
	readonly manager: WorkflowsManagerInterface
	readonly stores?: MCPStoreManagerInterface
	readonly onBlocked?: (result: TaskResult, task: TaskInterface) => void
}

/**
 * Discriminated set of operations the workflow tool dispatches.
 *
 * @remarks
 * Sent by the model as the `operation` field in `execute()` arguments.
 */
export type WorkflowOperation =
	| 'create'
	| 'status'
	| 'advance'
	| 'snapshot'
	| 'restore'
	| 'list'
	| 'remove'

/**
 * Return value from `WorkflowToolInterface.execute()`.
 *
 * @remarks
 * `operation` — the operation that was dispatched.
 * `ok`        — whether the operation succeeded.
 * `output`    — operation-specific payload.
 * `error`     — populated when `ok` is `false`.
 * `duration`  — wall-clock time for the operation in milliseconds.
 */
export interface WorkflowToolResult {
	readonly operation: WorkflowOperation
	readonly ok: boolean
	readonly output: unknown
	readonly error: string | undefined
	readonly duration: number
}

/**
 * Standard tool wrapper for declarative workflow tracking.
 *
 * @remarks
 * Exposes workflow lifecycle operations as a single `execute()` call.
 * The model sends `{ operation, ...args }` and the tool routes to the
 * correct workflow method.
 *
 * Manages workflows via `WorkflowsManagerInterface`. Supports snapshot
 * persistence via optional `MCPStoreManagerInterface`.
 *
 * Follows the manager accessor pattern:
 * - `workflow(id)` → one or undefined
 * - `workflows()` → all active
 */
export interface WorkflowToolInterface extends ToolInterface {
	readonly stores: MCPStoreManagerInterface | undefined
	execute(args: Record<string, unknown>): Promise<WorkflowToolResult>
	init(): Promise<void>
	workflow(id: string): WorkflowInterface | undefined
	workflows(): readonly WorkflowInterface[]
	snapshots(): readonly string[]
	forget(): void
	forget(id: string): boolean
}
