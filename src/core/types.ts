import type { AgentInterface, ConversationStoreInterface } from '@orkestrel/agent'
import type { WorkspaceManagerInterface, WorkspaceStoreInterface } from '@orkestrel/workspace'
import type { TerminalManagerInterface } from '@orkestrel/terminal'
import type {
	WorkflowFault,
	WorkflowFunction,
	WorkflowFunctions,
	WorkflowRunnerInterface,
	WorkflowStatus,
	WorkflowStoreInterface,
} from '@orkestrel/workflow'
import type {
	DatabaseInterface,
	DriverInterface,
	IndexMap,
	KeyFunction,
	PrimaryMap,
} from '@orkestrel/database'
import type { RelationManagerInterface } from '@orkestrel/relation'

// Toolbox types — one interface per `create*Tool` / `create*Function` factory (AGENTS §5:
// types are the SOURCE OF TRUTH; implementation conforms to them, never the reverse). The
// workflow-authoring family (WorkflowSteps/WorkflowStep/WorkflowDraft/PhaseDraft/TaskDraft),
// WorkflowToolResult, and adapter options are OWNED here and consume the current
// `@orkestrel/workflow` contracts. WorkspaceOperation remains Toolbox's model-facing operation
// union over the editing surface owned by `@orkestrel/workspace`. Each tool exposes only the
// dependency configuration seams its handler actually composes.

// === Draft family (the workflow tool's LENIENT authoring surface — id/name optional)
//
// A DRAFT mirrors the `WorkflowDefinition` family (`@orkestrel/workflow`) EXACTLY except `id`
// and `name` are OPTIONAL at all three levels, so a small model can omit the six identity
// strings. It is NOT a runtime form — `createWorkflowDraftContract` validates it (a provided
// id/name still has `minLength: 1`, so an explicitly-empty `id: ''` is REJECTED, not "absent"),
// and `completeDraft` synthesizes any MISSING id positionally + defaults a missing name to its
// id, yielding a strict `WorkflowDefinition` that is THEN re-validated against the strict
// contract before running (soundness preserved). `run` stays optional (a plain name string),
// mirroring the definition family.

/**
 * A draft task — a `TaskDefinition` (`@orkestrel/workflow`) with OPTIONAL `id` / `name`.
 *
 * @remarks
 * The tool synthesizes a missing `id` positionally and defaults a missing `name` to its `id`
 * ({@link import('./helpers.js').completeDraft}). A PROVIDED `id` / `name` is preserved verbatim
 * (and must be non-empty — the draft contract's `minLength: 1`).
 */
export interface TaskDraft {
	readonly id?: string
	readonly name?: string
	readonly description?: string
	/** The behavior reference — a registry key resolved against a workflow's functions registry at construction; omitted ⇒ a deliberate JSON `null` no-op. */
	readonly run?: string
	/** Extra attempts after the first on failure (a non-negative integer); persisted with the workflow. */
	readonly retries?: number
	/** The per-attempt deadline in milliseconds (`0..MAX_TIMER_MS`); persisted with the workflow. */
	readonly timeout?: number
}

/** A draft phase — a `PhaseDefinition` (`@orkestrel/workflow`) with OPTIONAL `id` / `name` and {@link TaskDraft} tasks. */
export interface PhaseDraft {
	readonly id?: string
	readonly name?: string
	readonly description?: string
	readonly tasks: readonly TaskDraft[]
	/** Max tasks in flight at once (a resource throttle); omitted ⇒ unbounded. */
	readonly concurrency?: number
	/** The per-phase failure-policy OVERRIDE; omitted ⇒ inherits the workflow `bail`. */
	readonly bail?: boolean
}

/**
 * A draft workflow — a `WorkflowDefinition` (`@orkestrel/workflow`) with OPTIONAL `id` / `name`
 * at all three levels (workflow / phase / task).
 *
 * @remarks
 * The lenient authoring form {@link import('./factories.js').createWorkflowDraftContract}
 * validates and {@link import('./helpers.js').completeDraft} completes into a strict
 * `WorkflowDefinition`. `run` stays optional (a plain name string); the `bail` policy carries
 * over.
 */
export interface WorkflowDraft {
	readonly id?: string
	readonly name?: string
	readonly description?: string
	readonly phases: readonly PhaseDraft[]
	/** Failure policy: `false` (default) continues gracefully, `true` halts on the first failure. */
	readonly bail?: boolean
}

// === Flat-steps family (the workflow tool's ADVERTISED authoring surface — the simplest form)

/**
 * One flat step — `{ name }` — the building block of a {@link WorkflowSteps} blob.
 *
 * @remarks
 * `name` is the REGISTERED behavior name the step runs (it becomes the task's `run`, NOT a
 * human label) — resolved against a workflow-level functions registry at construction.
 */
export interface WorkflowStep {
	/** The registered behavior name this step runs (becomes the task's `run`). */
	readonly name: string
}

/**
 * The FLAT authoring blob {@link import('./factories.js').createWorkflowTool} advertises —
 * `{ name?, steps }` — the simplest surface a small model can fill.
 *
 * @remarks
 * Each {@link WorkflowStep} becomes a one-task phase, in order
 * ({@link import('./helpers.js').expandSteps}); `name` is the optional workflow name and
 * deterministic persistence id (both default to `wf` when omitted).
 */
export interface WorkflowSteps {
	readonly name?: string
	readonly steps: readonly WorkflowStep[]
}

/** The JSON-safe run summary returned by {@link import('./factories.js').createWorkflowTool}. */
export interface WorkflowToolResult {
	/** The workflow's native terminal status. */
	readonly status: WorkflowStatus
	/** The number of settled task results. */
	readonly count: number
	/** Whether the native runner stored its final state; omitted when no store was supplied. */
	readonly durable?: boolean
	/** The native runner's first persistence failure; omitted when none occurred. */
	readonly fault?: WorkflowFault
}

/** One immutable workflow/agent call chain, beginning with a workflow tag. */
export type WorkflowLineage = readonly string[]

/** Raw live agents keyed by the workflow function names that invoke them. */
export type WorkflowAgents = Readonly<Record<string, AgentInterface>>

/** A contextual agent adapter carrying immutable metadata for Toolbox composition. */
export type AgentFunction = WorkflowFunction & {
	readonly category: 'agent'
	readonly lineage: WorkflowLineage
}

/**
 * Options for {@link import('./factories.js').createAgentFunction} — the OPT-IN adapter that
 * wraps a live `AgentInterface` (`@orkestrel/agent`) as an {@link AgentFunction} with immutable
 * lineage metadata and optional nested-workflow composition.
 *
 * @remarks
 * All fields are optional. An empty lineage is resolved from the controller's root workflow when
 * the adapter runs; a configured lineage must already identify that exact workflow.
 * - `runner` — when supplied, the adapter binds a recursion-safe
 *   {@link import('./factories.js').createWorkflowTool} onto the agent's `context.tools` (the
 *   propagation seam), so the agent can author and run a nested workflow through it. Omitted ⇒ the
 *   agent runs with no workflow tool bound.
 * - `lineage` — the immutable alternating workflow/agent chain for this adapter's workflow.
 * - `functions` — opaque host-owned leaf functions propagated unchanged.
 * - `agents` — raw live agents Toolbox contextually adapts for each target workflow.
 * - `store` — the native runner checkpoint store propagated through nested runs.
 */
export interface AgentFunctionOptions {
	readonly runner?: WorkflowRunnerInterface
	readonly lineage?: WorkflowLineage
	readonly functions?: WorkflowFunctions
	readonly agents?: WorkflowAgents
	readonly store?: WorkflowStoreInterface
}

/**
 * Options for {@link import('./factories.js').createWorkflowTool} and
 * {@link import('./factories.js').createWorkflowFunctions} — lineage-aware composition of opaque
 * leaves, raw agents, and native workflow persistence.
 *
 * @remarks
 * A top-level workflow tool uses an empty lineage and establishes its authored target as depth
 * zero. A tool bound onto an agent carries a lineage ending in that agent; the target workflow is
 * appended at invocation. `functions` remains strictly opaque host behavior. `agents` is the raw
 * live registry Toolbox uses to mint target-specific {@link AgentFunction}s. `store` is forwarded
 * to the native runner, which owns checkpoints and reports final durability/fault state.
 */
export interface WorkflowToolOptions {
	readonly lineage?: WorkflowLineage
	readonly functions?: WorkflowFunctions
	readonly agents?: WorkflowAgents
	readonly store?: WorkflowStoreInterface
}

/**
 * Options for {@link import('./factories.js').createWorkspaceTool} — EITHER a caller-built
 * {@link WorkspaceManagerInterface} to drive directly, OR a {@link WorkspaceStoreInterface} the
 * tool constructs a fresh manager over; neither given constructs a manager over
 * `@orkestrel/workspace`'s in-memory store.
 *
 * @remarks
 * - `manager` — drive THIS manager directly (its `active` workspace is what every edit / read
 *   operation targets). Takes priority over `store` when both are supplied.
 * - `store` — construct a manager over this durable {@link WorkspaceStoreInterface} (via
 *   `@orkestrel/workspace`'s `createWorkspaceManager`) — used only when `manager` is omitted.
 *   The store only backs the manager's own `open` / `save` operations: the tool's edits are
 *   NOT auto-persisted — durability requires an explicit caller `save` on the manager
 *   (unlike the workflow tool's `store`, which is forwarded into native run-wide checkpoints).
 * - `name` / `description` — advertised tool overrides; default to
 *   {@link import('./constants.js').WORKSPACE_TOOL_NAME} / {@link import('./constants.js').WORKSPACE_TOOL_DESCRIPTION}.
 */
export interface WorkspaceToolOptions {
	readonly name?: string
	readonly description?: string
	readonly manager?: WorkspaceManagerInterface
	readonly store?: WorkspaceStoreInterface
}

// === Workspace operation union

/**
 * One operation an agent invokes through {@link import('./factories.js').createWorkspaceTool} — a
 * FLAT, descriptive tagged union over the 13 workspace edit / read / navigation actions,
 * discriminated by the `operation` literal (AGENTS §4.8: a discriminant is named for its axis —
 * the action being performed — NEVER `kind`).
 *
 * @remarks
 * This is the SOURCE OF TRUTH the tool contract is typed to
 * ({@link import('./shapers.js').workspaceToolShape} compiles to a structurally-identical guard /
 * parser / JSON Schema). Every field is FLAT (no nested objects) — the small-model ergonomic
 * lever: a range edit is the four flat integers of the `'splice'` arm (`fromLine` /
 * `fromColumn` / `toLine` / `toColumn`), reassembled into a 1-based `Range`
 * (`@orkestrel/workspace`)
 * by `rangeOf`, never a nested `{ start, end }`. Each EDIT / READ arm maps onto exactly one
 * `WorkspaceInterface` call against the manager's ACTIVE workspace; the two REGISTRY arms
 * (`switch` / `workspaces`) drive the {@link WorkspaceManagerInterface} pointer instead —
 * `workspaces` LISTS the workspaces the model can move between, and `switch` re-points which one
 * the edit / read arms target.
 */
export type WorkspaceOperation =
	/** Read a whole text file's text by `path` from the ACTIVE workspace (a binary / absent path — or no active workspace — yields no content). */
	| { readonly operation: 'read'; readonly path: string }
	/** List every file in the ACTIVE workspace (path / state / size / lines / kind summaries); `[]` when no workspace is active. */
	| { readonly operation: 'list' }
	/** Whether a file exists at `path` in the ACTIVE workspace (`false` when no workspace is active). */
	| { readonly operation: 'has'; readonly path: string }
	/**
	 * Scan every text file for `query`, returning each hit (path + 1-based line / column + the line).
	 *
	 * @remarks
	 * `regex` treats `query` as a regular-expression source (default `false` — a literal substring);
	 * `sensitive` matches case-sensitively (default `true`); `limit` caps the total hits returned.
	 */
	| {
			readonly operation: 'search'
			readonly query: string
			readonly regex?: boolean
			readonly sensitive?: boolean
			readonly limit?: number
	  }
	/**
	 * Replace `query` with `replacement` across every text file, returning the tally.
	 *
	 * @remarks
	 * Same matching axes as `search`: `regex` (default `false`), `sensitive` (default `true`),
	 * `limit` (cap the total replacements).
	 */
	| {
			readonly operation: 'replace'
			readonly query: string
			readonly replacement: string
			readonly regex?: boolean
			readonly sensitive?: boolean
			readonly limit?: number
	  }
	/** Write (create or overwrite) the whole file at `path` with `content`. */
	| { readonly operation: 'write'; readonly path: string; readonly content: string }
	/**
	 * Splice `content` into an existing text file, replacing the 1-based range
	 * `(fromLine, fromColumn)` (INCLUSIVE) → `(toLine, toColumn)` (EXCLUSIVE).
	 *
	 * @remarks
	 * The FLAT range edit — the four positive-integer caret components reassemble into a `Range`
	 * (`@orkestrel/workspace`) via `rangeOf`. An empty span (`from === to`) inserts; a span past
	 * the end is clamped. An inverted / sub-1 range throws `RANGE`; a binary target throws
	 * `MODALITY`.
	 */
	| {
			readonly operation: 'splice'
			readonly path: string
			readonly content: string
			readonly fromLine: number
			readonly fromColumn: number
			readonly toLine: number
			readonly toColumn: number
	  }
	/** Prepend `content` to the start of the file at `path` (creating it when absent). */
	| { readonly operation: 'prepend'; readonly path: string; readonly content: string }
	/** Append `content` to the end of the file at `path` (creating it when absent). */
	| { readonly operation: 'append'; readonly path: string; readonly content: string }
	/** Re-key the file `from` → `to` (overwriting an occupied target). */
	| { readonly operation: 'move'; readonly from: string; readonly to: string }
	/** Remove the file at `path` from the workspace. */
	| { readonly operation: 'remove'; readonly path: string }
	/** List the workspaces the model can move between — each `{ id, files, active }` — so it can choose an `id` to `switch` to. */
	| { readonly operation: 'workspaces' }
	/** Re-point the manager's ACTIVE workspace to the one with `id` (an unknown `id` is a lenient no-op). The edit / read arms target the active workspace from then on. */
	| { readonly operation: 'switch'; readonly id: string }

/**
 * Options for {@link import('./factories.js').createAgentTool} — the sub-agent delegation
 * defaults, the nesting-depth / cycle guard bookkeeping, and the advertised tool overrides.
 *
 * @remarks
 * - `name` / `description` — advertised tool overrides; default to
 *   {@link import('./constants.js').AGENT_TOOL_NAME} / {@link import('./constants.js').AGENT_TOOL_DESCRIPTION}.
 * - `provider` — the DEFAULT registry provider key used when a call omits `provider`; a call
 *   that supplies its own `provider` overrides this. One of `provider` (here or per-call) MUST
 *   resolve, or the handler throws a typed `TOOL` {@link import('./errors.js').ToolboxError}.
 * - `tools` — the DEFAULT registry tool-name list loaded into the delegated sub-agent; a
 *   per-call `tools` list overrides (never merges with) this default.
 * - `system` — the DEFAULT system prompt seeding the sub-agent's context; a per-call `system`
 *   overrides this.
 * - `depth` — this invocation's nesting depth (default `0`); a delegated sub-agent that itself
 *   calls this tool again runs at `depth + 1`, bounded by
 *   {@link import('./constants.js').AGENT_TOOL_DEPTH}.
 * - `ancestry` — the sub-agent identifiers already in this delegation chain (default empty); a
 *   cycle (the resolved agent already present) is rejected with a typed `DEPTH`
 *   {@link import('./errors.js').ToolboxError}.
 * - `store` — this package's ADDITION: when supplied, the handler persists the delegated
 *   sub-agent's active conversation snapshot (`store.set(agent.context.conversations.active.snapshot())`)
 *   once `agent.generate()` settles successfully, before returning — one snapshot per delegation
 *   (each `registry.build` mints a fresh conversation id, so a shared store accumulates an
 *   audit log rather than colliding). Omitted ⇒ no persistence from this tool.
 *
 * Conversation persistence for a delegated sub-agent has TWO independent seams, composable
 * together: this `store` slot persists EACH delegation's conversation individually, and/or an
 * `AgentRegistryInterface` built with `AgentRegistryOptions.store` (`@orkestrel/agent`) backs
 * EVERY agent it builds — including ones built through this tool — with a store-backed
 * `ConversationManagerInterface` of its own. Neither is required; either or both may be used.
 */
export interface AgentToolOptions {
	readonly name?: string
	readonly description?: string
	readonly provider?: string
	readonly tools?: readonly string[]
	readonly system?: string
	readonly depth?: number
	readonly ancestry?: readonly string[]
	readonly store?: ConversationStoreInterface
}

/**
 * The FLAT args {@link import('./factories.js').createAgentTool} accepts — a delegated `task`
 * plus the minimal optional `AgentJobInput` (`@orkestrel/agent`) fields a caller may override
 * per-call.
 *
 * @remarks
 * `task` becomes the seed user message in the sub-agent's rehydrated conversation
 * (`AgentJobInput.messages`). `provider` / `tools` / `system` shadow the tool's own
 * {@link AgentToolOptions} defaults for this ONE call when supplied.
 */
export interface AgentToolArguments {
	readonly task: string
	readonly provider?: string
	readonly tools?: readonly string[]
	readonly system?: string
}

/**
 * The seven-value machine-readable code a thrown
 * {@link import('./errors.js').ToolboxError} carries (AGENTS §14: a thrown, typed,
 * code-bearing error, never a `{ error }` return).
 *
 * @remarks
 * `TOOL` — malformed calls and package-owned resolution or configuration failures, including
 * unknown tools, terminals, databases, drivers, relation managers, or models; invalid prompt
 * choices or include paths; disabled readonly mutations; and invalid infer/endpoint inputs.
 * `DEPTH` — the delegation would exceed {@link import('./constants.js').AGENT_TOOL_DEPTH}, or
 * the resolved agent is already an ancestor (a cycle).
 * `DEADLOCK` — an `ask` call ({@link import('./factories.js').createPromptTool}) would form a
 * prompt cycle (`TerminalManagerInterface.ask`, `@orkestrel/terminal`, rejects with its own
 * `TerminalError('DEADLOCK')`, re-surfaced here).
 * `EXPIRE` — an `ask` call's addressed prompt expired before it was answered.
 * `ANSWER` — {@link import('./factories.js').createAnswerTool}'s answer call failed to apply
 * because the prompt id is unknown or already settled, or the terminal manager rejected the
 * answer.
 * `DATABASE` — a typed `@orkestrel/database` failure (`DatabaseError`), re-surfaced with the
 * granular {@link import('@orkestrel/database').DatabaseErrorCode} carried in `context.code`.
 * `RELATION` — a typed `@orkestrel/relation` failure (`RelationError`), re-surfaced with the
 * granular {@link import('@orkestrel/relation').RelationErrorCode} carried in `context.code`.
 */
export type ToolboxErrorCode =
	| 'TOOL'
	| 'DEPTH'
	| 'DEADLOCK'
	| 'EXPIRE'
	| 'ANSWER'
	| 'DATABASE'
	| 'RELATION'

/**
 * The FLAT args {@link import('./factories.js').createDescribeTool} accepts — the registered
 * tool `name` whose full `description` a model wants back.
 *
 * @remarks
 * `name` must match a tool registered on the {@link import('@orkestrel/tool').ToolManagerInterface}
 * the describe tool was built over — it is looked up via `tools.tool(name)`.
 */
export interface DescribeToolArguments {
	readonly name: string
}

/**
 * Options for {@link import('./factories.js').createPromptTool} — the live
 * {@link TerminalManagerInterface} (`@orkestrel/terminal`) to `ask` through, the terminal name
 * `from`, and the advertised tool overrides.
 *
 * @remarks
 * - `manager` — the terminal manager whose `ask(from, to, form, options)` the tool's handler
 *   calls; BLOCKS the calling agent turn until the addressed terminal answers (or the ask
 *   rejects — a cycle throws `TerminalError('DEADLOCK')`, re-surfaced as a typed `DEADLOCK`
 *   {@link import('./errors.js').ToolboxError}; an expired prompt re-surfaces as `EXPIRE`).
 * - `from` — the terminal identity this tool asks AS; the model supplies the `to` target and the
 *   prompt form per call.
 * - `name` / `description` — advertised tool overrides; default to
 *   {@link import('./constants.js').PROMPT_TOOL_NAME} / {@link import('./constants.js').PROMPT_TOOL_DESCRIPTION}.
 */
export interface PromptToolOptions {
	readonly manager: TerminalManagerInterface
	readonly from: string
	readonly name?: string
	readonly description?: string
}

/**
 * Options for {@link import('./factories.js').createAnswerTool} — the live
 * {@link TerminalManagerInterface} (`@orkestrel/terminal`) to list / answer prompts through, the
 * terminal name `to`, and the advertised tool overrides.
 *
 * @remarks
 * - `manager` — the terminal manager whose `pending(to)` / `answer(to, id, value)` the tool's
 *   handler calls — `pending` lists the prompts currently addressed to `to`, `answer` resolves
 *   one by `id`. A failed `answer` (`TerminalAnswerResult.error`) re-surfaces as a typed
 *   `ANSWER` {@link import('./errors.js').ToolboxError}.
 * - `to` — the terminal identity this tool lists / answers prompts FOR.
 * - `name` / `description` — advertised tool overrides; default to
 *   {@link import('./constants.js').ANSWER_TOOL_NAME} / {@link import('./constants.js').ANSWER_TOOL_DESCRIPTION}.
 */
export interface AnswerToolOptions {
	readonly manager: TerminalManagerInterface
	readonly to: string
	readonly name?: string
	readonly description?: string
}

// === Database definition (config-only, for the upcoming database / relation tools)

/** One column's declared type — a primitive shorthand, or `integer` for a whole-number `number`. */
export type ColumnKind = 'string' | 'integer' | 'number' | 'boolean'

/**
 * One table column's spec — either a bare {@link ColumnKind} shorthand, or `{ type, optional }`
 * when the column may be absent from a row.
 */
export type ColumnSpec = ColumnKind | Readonly<{ type: ColumnKind; optional?: boolean }>

/**
 * A database's table layout — one entry per table, each a flat map of column name to
 * {@link ColumnSpec}. The small-model-facing DSL {@link import('./helpers.js').expandTables}
 * compiles into an `@orkestrel/database` `TableMap`.
 */
export type TableSpec = Readonly<
	Record<string, Readonly<{ columns: Readonly<Record<string, ColumnSpec>> }>>
>

/**
 * One database's CONFIG-ONLY definition — `id` + `driver` + {@link TableSpec}, with optional
 * `primary`, `indexes`, and `version` schema configuration.
 *
 * @remarks
 * A `DatabaseDefinition` is NEVER a live handle — it is the durable, serializable config a
 * {@link DefinitionStoreInterface} persists and a tool factory turns into a real
 * `@orkestrel/database` `DatabaseInterface` (via `createDatabase` + {@link import('./helpers.js').expandTables})
 * on demand. `primary` maps table names to primary-key columns; `indexes` maps table names to
 * index column groups; `version` opts a capable driver into open-time schema reconciliation.
 */
export interface DatabaseDefinition {
	readonly id: string
	readonly driver: string
	readonly tables: TableSpec
	readonly primary?: PrimaryMap
	readonly indexes?: IndexMap
	readonly version?: number
}

/** One opaque persisted row — the shape a `TableInterface<DatabaseDefinitionRow>`-backed store reads/writes; `definition` is narrowed with {@link import('./helpers.js').isDatabaseDefinition} on read. */
export interface DatabaseDefinitionRow {
	readonly id: string
	readonly definition: unknown
}

/**
 * The point-access persistence seam (AGENTS §5 — Stores) for {@link DatabaseDefinition} configs —
 * the twin of `@orkestrel/terminal`'s `TerminalStoreInterface`, storing a database's CONFIG-ONLY
 * blueprint (never a live handle). Every primitive is async; `delete` of an absent id is a no-op.
 */
export interface DefinitionStoreInterface {
	get(id: string): Promise<DatabaseDefinition | undefined>
	set(definition: DatabaseDefinition): Promise<void>
	delete(id: string): Promise<void>
}

/**
 * Options for {@link import('./factories.js').createDatabaseTool} — SRC-2 of the 3-unit database
 * / relation spine, built over the SRC-1 foundation ({@link DatabaseDefinition},
 * {@link DefinitionStoreInterface}, {@link import('./helpers.js').expandTables}).
 *
 * @remarks
 * - `databases` — live `DatabaseInterface` handles to seed the tool's cache with (e.g. a
 *   caller-constructed database it should manage alongside store-backed ones); keyed by the id a
 *   call's `id` field addresses.
 * - `store` — the {@link DefinitionStoreInterface} the `'create'` operation persists its
 *   {@link DatabaseDefinition} CONFIG through, and `'destroy'` deletes from; also the source
 *   `'get'`/every other operation resolves an id from when it isn't already cached. Omitted means
 *   no persistence — a database created without a store lives only for the tool's lifetime.
 * - `drivers` — registry of driver-name to `() => DriverInterface` factories a `'create'` call's
 *   `driver` field (or a persisted definition's `driver`) resolves against. Defaults to
 *   `{ memory: () => createMemoryDriver() }` (`@orkestrel/database`).
 * - `generator` — the optional `KeyFunction` (`@orkestrel/database`) every minted database is
 *   constructed with, used when a written row lacks its primary key. Omitted delegates to the
 *   database's default generator.
 * - `limit` — the `'records'` row cap — via {@link import('./helpers.js').clampQuery}
 *   — enforce when a call's `query.limit` is omitted or exceeds it. Defaults to
 *   {@link import('./constants.js').DATABASE_TOOL_LIMIT}.
 * - `timeout` — a nonnegative safe-integer number of milliseconds. A fresh
 *   `AbortSignal.timeout(timeout)` is passed only to table operations whose current database API
 *   accepts operation options: `records`, `count`, `aggregate`, `add`, `set`, `update`, and
 *   `remove`. It does not bound store resolution, construction, schema inspection, `get`, or
 *   `close`, and is not an outer tool-call deadline.
 * - `readonly` — when `true`, every mutating operation (`'create'` / `'add'` / `'set'` /
 *   `'update'` / `'remove'` / `'destroy'`) throws a typed `TOOL`
 *   {@link import('./errors.js').ToolboxError} before doing anything.
 * - `name` / `description` — advertised tool overrides; default to
 *   {@link import('./constants.js').DATABASE_TOOL_NAME} / {@link import('./constants.js').DATABASE_TOOL_DESCRIPTION}.
 */
export interface DatabaseToolOptions {
	readonly name?: string
	readonly description?: string
	readonly databases?: Readonly<Record<string, DatabaseInterface>>
	readonly store?: DefinitionStoreInterface
	readonly drivers?: Readonly<Record<string, () => DriverInterface>>
	readonly generator?: KeyFunction
	readonly limit?: number
	readonly timeout?: number
	readonly readonly?: boolean
}

/**
 * Options for {@link import('./factories.js').createRelationTool} — SRC-3 (the final unit) of
 * the 3-unit database / relation spine.
 *
 * @remarks
 * - `managers` — the live `RelationManagerInterface` (`@orkestrel/relation`) registry a call's
 *   optional `manager` field addresses by name; REQUIRED (unlike the database tool's lazily
 *   resolved handles, a relation manager's relations are declared up front and cannot be minted
 *   on demand from a tool call). A call that omits `manager` resolves to the SOLE registered
 *   manager when exactly one is registered, else throws a typed `TOOL`
 *   {@link import('./errors.js').ToolboxError} naming the registered manager keys.
 * - `limit` — the row cap `'find'` / `'links'` enforce when a call's `limit` is omitted or
 *   exceeds it. Defaults to {@link import('./constants.js').RELATION_TOOL_LIMIT}.
 * - `depth` — the max dot-path segment count `'load'` / `'find'`'s `include` paths may reach
 *   ({@link import('./helpers.js').expandInclude}). Defaults to
 *   {@link import('./constants.js').RELATION_TOOL_DEPTH}.
 * - `name` / `description` — advertised tool overrides; default to
 *   {@link import('./constants.js').RELATION_TOOL_NAME} / {@link import('./constants.js').RELATION_TOOL_DESCRIPTION}.
 */
export interface RelationToolOptions {
	readonly name?: string
	readonly description?: string
	readonly managers: Readonly<Record<string, RelationManagerInterface>>
	readonly limit?: number
	readonly depth?: number
}

// === Infer / endpoint bridge (existing API/DB → MCP tool)
//
// `createInferTool` and `createEndpointTool` bridge an EXISTING API/DB surface into an
// LLM-callable `ToolInterface`, built on `@orkestrel/contract`'s sample-based schema inference
// (`samplesToSchema` / `schemaToObject` / `schemaToParameters`) and, since `@orkestrel/contract`
// 0.0.7, its validating inverse `schemaToShape` (an inferred `JSONSchema` → a `ContractShape`).
// `createInferTool` is a STANDALONE utility tool a model calls directly to learn a JSON Schema
// from example values; `createEndpointTool` wraps one CONCRETE endpoint (`EndpointDefinition`) —
// its `parameters` are inferred ONCE at construction from `samples` and advertised to steer the
// model, and by DEFAULT `execute` ENFORCES that same advertised schema against the model-supplied
// `args` before calling `invoke` (`EndpointToolOptions.validate`, default `true`) — see the
// Contract invariant in `tool.md`.

/**
 * Options for {@link import('./factories.js').createInferTool} — advertised name/description
 * overrides only; `format` / `enum` are RUNTIME call arguments (see
 * {@link import('./shapers.js').inferToolShape}), not construction-time options, since a model
 * chooses them per call.
 */
export interface InferToolOptions {
	readonly name?: string
	readonly description?: string
}

/**
 * The handler {@link import('./types.js').EndpointDefinition.invoke} implements — mirrors
 * `@orkestrel/tool`'s `ToolOptions.execute` signature EXACTLY (same `Readonly<Record<string,
 * unknown>>` argument, same `Promise<unknown> | unknown` return) so
 * `execute: (args) => definition.invoke(args)` typechecks with zero assertions in
 * {@link import('./factories.js').createEndpointTool}.
 */
export type EndpointHandler = (
	args: Readonly<Record<string, unknown>>,
) => Promise<unknown> | unknown

/**
 * One concrete endpoint {@link import('./factories.js').createEndpointTool} wraps as an
 * LLM-callable `ToolInterface` — the advertised identity, a non-empty set of example values its
 * `parameters` are inferred from, and the local handler that runs a call.
 *
 * @remarks
 * `samples` MUST be non-empty — {@link import('./factories.js').createEndpointTool} throws a
 * typed `TOOL` {@link import('./errors.js').ToolboxError} at CONSTRUCTION when it is empty,
 * since an empty sample set cannot infer a schema. By DEFAULT ({@link EndpointToolOptions.validate}
 * `true`) `invoke` receives the PARSED, NORMALIZED args record — a copy of the model-supplied
 * `args` with each scalar coerced to its inferred type (e.g. a number sent for a string slot
 * arrives coerced to a string), checked against the same schema advertised as `parameters` — and
 * a call with a missing required key or a non-coercible value never reaches `invoke` at all (see
 * {@link EndpointToolOptions.validate}). With
 * `validate: false`, `invoke` receives the model-supplied `args` VERBATIM (raw passthrough, never
 * checked against the inferred schema). Either way `invoke`'s return flows back as the tool
 * call's result; a throw PROPAGATES uncaught, isolated by the `ToolManagerInterface`
 * (`@orkestrel/tool`) into the canonical error envelope. When `samples` are non-object values,
 * the advertised schema wraps them under a single required `value` property, so `invoke` receives
 * an `args` record of the shape `{ value: ... }` — never the bare value.
 */
export interface EndpointDefinition {
	readonly name: string
	readonly description: string
	readonly samples: readonly unknown[]
	readonly invoke: EndpointHandler
}

/**
 * Construction-time tuning for {@link import('./factories.js').createEndpointTool} — the
 * inferred `parameters` schema's `format` / `enum` constraints, and whether that same schema is
 * ENFORCED at `execute` time.
 *
 * @remarks
 * `format` / `enum` default to `false`, matching `@orkestrel/contract`'s own
 * `ValueToSchemaOptions` defaults. `validate` defaults to `true`: the schema
 * `createEndpointTool` advertises as `parameters` (`samplesToSchema` + `schemaToObject`) is
 * compiled ONCE at construction (via `@orkestrel/contract` 0.0.7's `schemaToShape`) into a
 * `ContractInterface` used to `parse` every call's `args` before `invoke` runs — a NORMALIZING
 * parse: a scalar value is COERCED to its inferred type where the house parsers coerce (a number
 * to/from a numeric string, a boolean from `'1'`/`'0'`/`'true'`/`'false'`/`1`/`0`), so `invoke`
 * receives the COERCED values (e.g. `7` sent for a string slot arrives at `invoke` as `'7'`), not
 * the raw call args. A call whose `args` fails to parse — a required key missing, or a value not
 * coercible to its slot's type — THROWS a typed `TOOL` {@link import('./errors.js').ToolboxError}
 * carrying the structured `explain` faults, and `invoke` is never called. Beyond that coercion,
 * enforcement is STRUCTURAL — required keys, `enum` membership, and numeric bounds — `format`
 * annotations (`email`, `date-time`, `uuid`, `uri`, ...) are NEVER asserted, mirroring
 * `@orkestrel/contract`'s own widening-only law for `schemaToShape`: a `format: true`-tuned
 * endpoint still ACCEPTS a non-conforming string in a format-tagged slot. A key NOT present in
 * the inferred (closed, `additionalProperties: false`) schema is NEVER a rejection either — it is
 * SILENTLY DROPPED before `invoke` runs (the same leniency `@orkestrel/contract`'s own `parse`
 * grants a closed object generally), so `invoke` may see fewer keys than the caller sent. Set
 * `validate: false` to restore the PRE-0.0.7 behavior exactly — `execute` passes the
 * model-supplied `args` straight to `invoke` UNCHANGED, unchecked and unstripped.
 */
export interface EndpointToolOptions {
	readonly format?: boolean
	readonly enum?: boolean
	readonly validate?: boolean
}
