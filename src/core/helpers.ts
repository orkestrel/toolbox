import type { WorkflowDefinition, WorkflowResult, WorkflowStatus } from '@orkestrel/workflow'
import type { PromptType } from '@orkestrel/terminal'
import type { TablesShape } from '@orkestrel/database'
import type { DatabaseErrorCode } from '@orkestrel/database'
import type {
	Include,
	ModelInterface,
	RelationErrorCode,
	RelationManagerInterface,
} from '@orkestrel/relation'
import type { Condition, Connector, Criteria, Direction, TableSchema } from '@orkestrel/database'
import type { ColumnSchema } from '@orkestrel/database'
import type { ContractShape } from '@orkestrel/contract'
import type {
	AgentToolErrorCode,
	ColumnKind,
	ColumnSpec,
	DatabaseDefinition,
	TableSpec,
} from './types.js'
import type { PhaseDraft, TaskDraft, WorkflowDraft, WorkflowSteps } from './types.js'
import { isTerminalError } from '@orkestrel/terminal'
import { isDatabaseError, shapeToColumnType } from '@orkestrel/database'
import { isRelationError } from '@orkestrel/relation'
import { AgentToolError } from './errors.js'
import {
	booleanShape,
	integerShape,
	isNonEmptyString,
	isRecord,
	isString,
	numberShape,
	optionalShape,
	stringShape,
} from '@orkestrel/contract'

// Tool-package helpers — OWNED here now, ported byte-faithfully from `@orkestrel/workflow` ahead
// of the upstream cleanup that drops the authoring surface from that package (this package
// becomes the defining home for the workflow tool's lenient-authoring pipeline and its ancestry
// tagging).

/**
 * The ancestry identifier of a workflow in a run chain — `workflow:<id>`.
 *
 * @remarks
 * Namespacing keeps a workflow id and an {@link agentTag} agent name in ONE set without
 * collision, so re-entering a workflow OR an agent already in the chain is a single `includes`
 * check.
 *
 * @param id - The workflow definition's `id`
 * @returns The namespaced ancestry tag (`workflow:<id>`)
 */
export function workflowTag(id: string): string {
	return `workflow:${id}`
}

/**
 * The ancestry identifier of an agent in a run chain — `agent:<name>`.
 *
 * @remarks
 * The agent counterpart of {@link workflowTag}: {@link import('./factories.js').createAgentFunction}
 * / {@link import('./factories.js').createWorkflowTool} guard against re-entering an agent or
 * workflow already in the chain (a typed `DEPTH` `WorkflowError`, `@orkestrel/workflow`). The
 * `agent:` namespace keeps it distinct from a same-string workflow id.
 *
 * @param name - The agent's identifier / registry name
 * @returns The namespaced ancestry tag (`agent:<name>`)
 */
export function agentTag(name: string): string {
	return `agent:${name}`
}

/**
 * Build the plain success summary {@link import('./factories.js').createWorkflowTool} returns on
 * a completed run — the universal tool-handler contract (AGENTS §14): return a plain value on
 * success, appearing identically over BOTH the agent loop and MCP.
 *
 * @remarks
 * The summary is LEAN: the workflow's terminal `status` and the COUNT of settled task results —
 * enough for a caller / model to react without serializing the whole live tree. (It carries no
 * synthetic `id` / `name`: a tool handler has no call id; the `ToolManagerInterface`
 * (`@orkestrel/agent`) supplies the canonical envelope's identity.)
 *
 * @param result - The terminal `WorkflowResult` (`@orkestrel/workflow`) the run produced
 * @returns The plain success summary — `{ status, count }`
 */
export function workflowToolSummary(
	result: WorkflowResult,
): Readonly<{ status: WorkflowStatus; count: number }> {
	return { status: result.status, count: result.results.length }
}

// === Draft completion + flat-steps expansion (the tool's LENIENT authoring surfaces)
//
// Pure, deterministic synthesis that turns a WIDENED authoring form into a strict
// `WorkflowDefinition` (`@orkestrel/workflow`). They auto-fill only OMITTED identity (a provided
// id/name is preserved verbatim; an explicitly-empty `id: ''` is rejected UPSTREAM by the draft
// contract, never reached here), so a small model can author a complete tree without emitting
// the six required `id`/`name` strings. The factory re-validates the result against the STRICT
// `createWorkflowContract().is` gate before running (soundness).

/**
 * Complete a {@link WorkflowDraft} into a strict {@link WorkflowDefinition} — synthesize any
 * MISSING `id` deterministically + positionally, and default any MISSING `name` to its
 * (now-resolved) `id`.
 *
 * @remarks
 * The positional id scheme is stable and human-legible: the workflow is `wf`, phase `i` is
 * `phase-<i>`, and task `j` of that phase is `<phaseId>-task-<j>` (so a provided phase id flows
 * into its tasks' synthesized ids). A PROVIDED `id` / `name` at any level is kept VERBATIM —
 * synthesis touches only the omitted ones. A missing `name` defaults to the resolved `id` (never
 * the other way round), so the result always has both. `run`, `description`, the per-phase
 * `concurrency` / `bail`, the per-task `retries` / `timeout`, and the workflow `bail` carry over
 * unchanged. The result is a complete {@link WorkflowDefinition}; the caller still validates it
 * against the STRICT contract.
 *
 * @param draft - The draft workflow (id/name optional at all three levels)
 * @returns A complete {@link WorkflowDefinition} with every id/name filled
 */
export function completeDraft(draft: WorkflowDraft): WorkflowDefinition {
	const id = draft.id ?? 'wf'
	return {
		id,
		name: draft.name ?? id,
		...(draft.description === undefined ? {} : { description: draft.description }),
		phases: draft.phases.map((phase, index) => completePhaseDraft(phase, index)),
		...(draft.bail === undefined ? {} : { bail: draft.bail }),
	}
}

/**
 * Complete one {@link PhaseDraft} into a strict phase definition — the per-phase step of
 * {@link completeDraft} (phase `index` → `phase-<index>` when its id is omitted).
 *
 * @param phase - The draft phase
 * @param index - The phase's positional index in the workflow
 * @returns A complete phase definition
 */
export function completePhaseDraft(
	phase: PhaseDraft,
	index: number,
): WorkflowDefinition['phases'][number] {
	const id = phase.id ?? `phase-${index}`
	return {
		id,
		name: phase.name ?? id,
		...(phase.description === undefined ? {} : { description: phase.description }),
		tasks: phase.tasks.map((task, taskIndex) => completeTaskDraft(task, id, taskIndex)),
		...(phase.concurrency === undefined ? {} : { concurrency: phase.concurrency }),
		...(phase.bail === undefined ? {} : { bail: phase.bail }),
	}
}

/**
 * Complete one {@link TaskDraft} into a strict task definition — the per-task leaf step of
 * {@link completeDraft} (task `index` of phase `<phaseId>` → `<phaseId>-task-<index>` when its id
 * is omitted).
 *
 * @param task - The draft task
 * @param phaseId - The (resolved) parent phase id, so the synthesized task id nests under it
 * @param index - The task's positional index within its phase
 * @returns A complete task definition
 */
export function completeTaskDraft(
	task: TaskDraft,
	phaseId: string,
	index: number,
): WorkflowDefinition['phases'][number]['tasks'][number] {
	const id = task.id ?? `${phaseId}-task-${index}`
	return {
		id,
		name: task.name ?? id,
		...(task.description === undefined ? {} : { description: task.description }),
		...(task.run === undefined ? {} : { run: task.run }),
		...(task.retries === undefined ? {} : { retries: task.retries }),
		...(task.timeout === undefined ? {} : { timeout: task.timeout }),
	}
}

/**
 * Expand a flat {@link WorkflowSteps} blob into a strict {@link WorkflowDefinition} — each step
 * becomes a one-task phase, IN ORDER.
 *
 * @remarks
 * The expansion of the tool's ADVERTISED surface: the deliberately-reduced flat form. Each
 * {@link import('./types.js').WorkflowStep} maps to a phase holding exactly one task: the step's
 * `name` becomes the task's `run` (the behavior-registry key). Ids/names are auto-filled
 * positionally — it builds an ids-omitted {@link WorkflowDraft} and delegates to
 * {@link completeDraft}, so the two lenient surfaces share ONE synthesis path (step `i` → phase
 * `phase-<i>`, its task `phase-<i>-task-0`). The optional `name` becomes the workflow's `name`.
 * The result is a complete definition the caller validates against the STRICT contract before
 * running.
 *
 * @param flat - The flat steps blob (`{ name?, steps: [{ name }] }`)
 * @returns A complete {@link WorkflowDefinition} (one one-task phase per step)
 */
export function expandSteps(flat: WorkflowSteps): WorkflowDefinition {
	return completeDraft({
		...(flat.name === undefined ? {} : { name: flat.name }),
		phases: flat.steps.map((step) => ({
			tasks: [{ run: step.name }],
		})),
	})
}

// === Terminal-tool answer coercion + error-code mapping (the tool's answer surface)

/**
 * Normalize an LLM-supplied answer `value` to the type {@link PromptType} `form` expects, so a
 * caller that only ever emits strings can still answer a typed prompt.
 *
 * @remarks
 * `'confirm'` coerces to a `boolean` — a `boolean` passes through, and the strings `'true'` /
 * `'false'` (case-insensitively) map to it; any other string is truthy-coerced via
 * `Boolean(value)`. `'checkbox'` coerces to `readonly string[]` — an array passes through
 * (stringifying each entry), a comma-separated string splits + trims into one, and any other
 * single (non-comma) string becomes a one-item array. Every other form (`'input'` / `'password'`
 * / `'select'` / `'editor'`) coerces to a plain `string` — a string passes through verbatim; a
 * non-string, non-object scalar (`number` / `boolean`) stringifies via `String(value)`; an
 * object or array (no lossless string form) falls back to `''` rather than serializing garbage.
 * Pure and total — never throws.
 *
 * @param form - The {@link PromptType} the answer is being coerced FOR
 * @param value - The raw, LLM-supplied answer value
 * @returns The coerced answer — `boolean` for `'confirm'`, `readonly string[]` for `'checkbox'`,
 *   `string` otherwise
 */
export function coerceAnswer(
	form: PromptType,
	value: unknown,
): string | boolean | readonly string[] {
	if (form === 'confirm') {
		if (typeof value === 'boolean') return value
		if (typeof value === 'string') {
			const lower = value.trim().toLowerCase()
			if (lower === 'true') return true
			if (lower === 'false') return false
		}
		return Boolean(value)
	}
	if (form === 'checkbox') {
		if (Array.isArray(value)) return value.map((entry) => String(entry))
		if (typeof value === 'string') {
			if (value.includes(',')) return value.split(',').map((entry) => entry.trim())
			return [value]
		}
		return [String(value)]
	}
	// The remaining text-shaped forms ('input'/'password'/'select'/'editor').
	if (typeof value === 'string') return value
	if (typeof value === 'object' && value !== null) return ''
	return String(value)
}

/**
 * Map a caught error to the {@link AgentToolErrorCode} the terminal-tool factory should throw
 * with — the pure classification step of that factory's error handling.
 *
 * @remarks
 * Narrows `error` with {@link isTerminalError} (`@orkestrel/terminal`) first: a non-`TerminalError`
 * value returns `undefined`, telling the caller this mapper does not apply (rethrow / handle
 * otherwise). For a genuine `TerminalError`, `'DEADLOCK'` maps to `'DEADLOCK'`, `'EXPIRE'` maps
 * to `'EXPIRE'`, and every other {@link import('@orkestrel/terminal').TerminalErrorCode}
 * (`'TARGET'`, `'CANCEL'`, `'DRIVER'`) maps to the generic `'TOOL'` code. The mapper only
 * classifies — the factory performs the actual throw.
 *
 * @param error - The value caught from a terminal-manager operation (`ask` / `answer` / …)
 * @returns The mapped {@link AgentToolErrorCode}, or `undefined` if `error` is not a `TerminalError`
 */
export function terminalToolCode(error: unknown): AgentToolErrorCode | undefined {
	if (!isTerminalError(error)) return undefined
	if (error.code === 'DEADLOCK') return 'DEADLOCK'
	if (error.code === 'EXPIRE') return 'EXPIRE'
	return 'TOOL'
}

// === Database-tool foundation (SRC-1 — persistence + the TableSpec DSL; the tool factories land
// in a later unit) — the config-only `DatabaseDefinition` compiles into a live `@orkestrel/database`
// `TablesShape`, and its store twins narrow an untrusted persisted blob back to the type.

/** Narrow an unknown value to a {@link ColumnSpec} — a valid {@link import('./types.js').ColumnKind} shorthand, or `{ type, optional }` with a valid `type`. */
export function isColumnSpec(value: unknown): value is ColumnSpec {
	if (isColumnKind(value)) return true
	if (!isRecord(value)) return false
	return (
		isColumnKind(value.type) &&
		(value.optional === undefined || typeof value.optional === 'boolean')
	)
}

/** Narrow an unknown value to a {@link import('./types.js').ColumnKind}. */
export function isColumnKind(value: unknown): value is ColumnKind {
	return value === 'string' || value === 'integer' || value === 'number' || value === 'boolean'
}

/**
 * Compile a {@link TableSpec} into the `@orkestrel/database` {@link TablesShape} it configures —
 * each {@link ColumnSpec} maps to the matching primitive shaper (`'string'` → `stringShape()`,
 * `'integer'` → `integerShape()`, `'number'` → `numberShape()`, `'boolean'` → `booleanShape()`),
 * wrapped in `optionalShape` when the column declares `optional: true`. Total, pure.
 *
 * @param spec - The small-model-facing table layout
 * @returns The compiled `TablesShape` a `@orkestrel/database` `createDatabase` call accepts
 */
export function expandTables(spec: TableSpec): TablesShape {
	const tables: Record<string, Readonly<Record<string, ContractShape>>> = {}
	for (const [table, definition] of Object.entries(spec)) {
		const columns: Record<string, ContractShape> = {}
		for (const [column, kind] of Object.entries(definition.columns)) {
			columns[column] = columnShape(kind)
		}
		tables[table] = columns
	}
	return tables
}

/** Compile one {@link ColumnSpec} into its `@orkestrel/database` column shape — the per-column leaf {@link expandTables} maps over. */
export function columnShape(spec: ColumnSpec): ContractShape {
	const kind = isString(spec) ? spec : spec.type
	const optional = !isString(spec) && spec.optional === true
	const shape = kindShape(kind)
	return optional ? optionalShape(shape) : shape
}

/** Map one {@link import('./types.js').ColumnKind} to its primitive `@orkestrel/database` shape — the leaf {@link columnShape} wraps. */
export function kindShape(kind: ColumnKind): ContractShape {
	if (kind === 'string') return stringShape()
	if (kind === 'integer') return integerShape()
	if (kind === 'number') return numberShape()
	return booleanShape()
}

/**
 * Narrow an unknown value to a {@link DatabaseDefinition} — a non-empty `id` + `driver`, a
 * `tables` record whose every value is `{ columns: record of valid ColumnSpec }`, and an optional
 * `keys` record of strings. The boundary guard a {@link import('./types.js').DefinitionStoreInterface}
 * applies to an untrusted persisted blob before trusting it as a definition (never an `as`).
 */
export function isDatabaseDefinition(value: unknown): value is DatabaseDefinition {
	if (!isRecord(value)) return false
	if (!isNonEmptyString(value.id) || !isNonEmptyString(value.driver)) return false
	if (!isRecord(value.tables)) return false
	for (const table of Object.values(value.tables)) {
		if (!isRecord(table) || !isRecord(table.columns)) return false
		for (const column of Object.values(table.columns)) {
			if (!isColumnSpec(column)) return false
		}
	}
	if (value.keys !== undefined) {
		if (!isRecord(value.keys)) return false
		for (const key of Object.values(value.keys)) {
			if (!isString(key)) return false
		}
	}
	return true
}

/**
 * Map a caught error to the {@link AgentToolErrorCode} the upcoming database tool should throw
 * with — the pure classification step of that factory's error handling, mirroring
 * {@link terminalToolCode}'s idiom for `@orkestrel/database`.
 *
 * @param error - The value caught from a `@orkestrel/database` table operation
 * @returns The granular {@link DatabaseErrorCode}, or `undefined` if `error` is not a `DatabaseError`
 */
export function databaseToolCode(error: unknown): DatabaseErrorCode | undefined {
	return isDatabaseError(error) ? error.code : undefined
}

/**
 * Map a caught error to the {@link AgentToolErrorCode} the upcoming relation tool should throw
 * with — the pure classification step of that factory's error handling, mirroring
 * {@link terminalToolCode}'s idiom for `@orkestrel/relation`.
 *
 * @param error - The value caught from a `@orkestrel/relation` operation
 * @returns The granular {@link RelationErrorCode}, or `undefined` if `error` is not a `RelationError`
 */
export function relationToolCode(error: unknown): RelationErrorCode | undefined {
	return isRelationError(error) ? error.code : undefined
}

/**
 * Expand the relation tool's FLAT dot-path `include` list into a live `@orkestrel/relation`
 * {@link Include} tree — the pure leaf {@link import('./factories.js').createRelationTool} calls
 * before a `'load'` / `'find'` call.
 *
 * @remarks
 * Each path splits on `'.'` into a chain of relation names, deep-merged into one nested
 * `Include` object with a leaf `true`. A longer path SUBSUMES a shorter sibling's bare `true` —
 * `'contacts'` followed by `'contacts.account'` yields `{ contacts: { account: true } }`, never
 * overwriting the deeper chain. An EMPTY segment (`''`, from a leading/trailing/doubled `.`) or a
 * path whose segment count exceeds `depth` throws a typed `TOOL` {@link AgentToolError}.
 *
 * @param paths - The flat dot-path `include` list (or `undefined` — yields `{}`)
 * @param depth - The max segment count a single path may reach
 * @returns The equivalent nested {@link Include}
 *
 * @example
 * ```ts
 * import { expandInclude } from '@src/core'
 *
 * expandInclude(['contacts', 'contacts.account'], 3)
 * // { contacts: { account: true } }
 * ```
 */
export function expandInclude(paths: readonly string[] | undefined, depth: number): Include {
	let include: Include = {}
	for (const path of paths ?? []) {
		const segments = path.split('.')
		if (segments.length > depth || segments.some((segment) => segment.length === 0)) {
			throw new AgentToolError('TOOL', `malformed include path '${path}'`, { path, depth })
		}
		const ancestors: Include[] = []
		let branch = include
		const last = segments.length - 1
		for (let index = 0; index < last; index++) {
			const segment = segments[index]
			if (segment === undefined) {
				throw new AgentToolError('TOOL', `malformed include path '${path}'`, { path, depth })
			}
			ancestors.push(branch)
			const existing = branch[segment]
			branch = typeof existing === 'object' ? existing : {}
		}
		const leaf = segments[last]
		if (leaf === undefined) {
			throw new AgentToolError('TOOL', `malformed include path '${path}'`, { path, depth })
		}
		const existing = branch[leaf]
		let merged: Include = {
			...branch,
			[leaf]: existing === undefined ? true : existing,
		}
		for (let index = last - 1; index >= 0; index--) {
			const ancestor = ancestors[index]
			const segment = segments[index]
			if (ancestor === undefined || segment === undefined) {
				throw new AgentToolError('TOOL', `malformed include path '${path}'`, { path, depth })
			}
			merged = { ...ancestor, [segment]: merged }
		}
		include = merged
	}
	return include
}

/**
 * Resolve which registered {@link RelationManagerInterface} a relation-tool call addresses — the
 * pure manager-resolution leaf {@link import('./factories.js').createRelationTool} calls on
 * every operation.
 *
 * @remarks
 * An explicit `name` must match a key of `managers` (a miss throws a typed `TOOL`
 * {@link AgentToolError} naming the registered managers). An OMITTED `name` resolves to the sole
 * registered manager when exactly one is registered, else throws the same typed error.
 *
 * @param managers - The tool's registered `RelationManagerInterface` map
 * @param name - The call's optional `manager` field
 * @returns The resolved {@link RelationManagerInterface}
 */
export function relationManagerOf(
	managers: Readonly<Record<string, RelationManagerInterface>>,
	name: string | undefined,
): RelationManagerInterface {
	if (name !== undefined) {
		const manager = managers[name]
		if (manager === undefined) {
			throw new AgentToolError('TOOL', `unknown relation manager '${name}'`, {
				manager: name,
				managers: Object.keys(managers),
			})
		}
		return manager
	}
	const names = Object.keys(managers)
	const [single] = names
	if (names.length === 1 && single !== undefined) {
		const manager = managers[single]
		if (manager !== undefined) return manager
	}
	throw new AgentToolError('TOOL', 'no relation manager resolved for the call', {
		managers: names,
	})
}

/**
 * Resolve a `model` name against a live {@link RelationManagerInterface} — the pure model-lookup
 * leaf {@link import('./factories.js').createRelationTool} calls on every operation, mirroring
 * {@link relationManagerOf}'s guard shape.
 *
 * @param manager - The resolved {@link RelationManagerInterface}
 * @param name - The call's `model` field
 * @returns The model's {@link ModelInterface}
 */
export function relationModelOf(manager: RelationManagerInterface, name: string): ModelInterface {
	if (!manager.has(name)) {
		throw new AgentToolError('TOOL', `unknown model '${name}'`, {
			model: name,
			models: manager.models(),
		})
	}
	return manager.model(name)
}

// === Database-tool operation leaves (SRC-2 — `createDatabaseTool` itself)

/**
 * Normalize the database tool's parsed SERIALIZED criteria into a live `@orkestrel/database`
 * {@link Criteria} — default each condition's OMITTED `connector` to `'and'`.
 *
 * @remarks
 * The wire form ({@link import('./shapers.js').databaseToolShape}) lets a caller drop `connector`
 * on the last condition (it has nothing to join FORWARD to); the compiled `Condition` a live
 * `@orkestrel/database` table call accepts always carries one, so this fills the gap. `order` /
 * `limit` / `offset` pass through unchanged. Pure and total.
 *
 * @param criteria - The parsed criteria (or `undefined`)
 * @returns The equivalent live `Criteria`, or `undefined` when `criteria` is `undefined`
 */
export function criteriaOf(
	criteria:
		| Readonly<{
				conditions?: readonly Readonly<{
					column: string
					operator: Condition['operator']
					values: readonly unknown[]
					connector?: Connector
				}>[]
				order?: readonly Readonly<{ column: string; direction: Direction }>[]
				limit?: number
				offset?: number
		  }>
		| undefined,
): Criteria | undefined {
	if (criteria === undefined) return undefined
	const conditions = criteria.conditions?.map((condition) => ({
		...condition,
		connector: condition.connector ?? 'and',
	}))
	return {
		...(conditions === undefined ? {} : { conditions }),
		...(criteria.order === undefined ? {} : { order: criteria.order }),
		...(criteria.limit === undefined ? {} : { limit: criteria.limit }),
		...(criteria.offset === undefined ? {} : { offset: criteria.offset }),
	}
}

/**
 * Clamp a `'records'` call's criteria to a row cap, and build the PROBE criteria the caller reads
 * with — the pure leaf {@link import('./factories.js').createDatabaseTool}'s `'records'` operation
 * uses to detect truncation without a separate `count` round trip.
 *
 * @remarks
 * The effective limit is `min(criteria?.limit ?? cap, cap)`, floored at `0` (so a caller can never
 * exceed the configured cap by supplying a larger `criteria.limit`). The returned probe criteria
 * requests ONE MORE row than the effective limit (`limit: effective + 1`) — if storage returns
 * that many, the caller knows the true result was truncated (`rows.length > effective`) and slices
 * back down to `effective` before returning.
 *
 * @example
 * ```ts
 * import { clampCriteria } from '@src/core'
 *
 * const { criteria, limit } = clampCriteria(undefined, 100)
 * // limit === 100, criteria.limit === 101 — a probe fetching one extra row
 * const rows = await table.records(criteria)
 * const truncated = rows.length > limit // true when storage had more than `limit` rows
 * ```
 *
 * @param criteria - The live criteria to clamp (or `undefined`)
 * @param cap - The row-count ceiling
 * @returns The PROBE criteria (`limit` bumped by one) and the effective `limit`
 */
export function clampCriteria(
	criteria: Criteria | undefined,
	cap: number,
): Readonly<{ criteria: Criteria; limit: number }> {
	const limit = Math.max(0, Math.min(criteria?.limit ?? cap, cap))
	return { criteria: { ...criteria, limit: limit + 1 }, limit }
}

/** Map a column NAME + its live `@orkestrel/database` `ContractShape` to a {@link ColumnSchema} — the leaf {@link tableSchema} maps over. */
export function columnSchema(name: string, shape: ContractShape): ColumnSchema {
	return {
		name,
		type: shapeToColumnType(shape),
		nullable: shape.type === 'optional' || shape.type === 'nullable',
	}
}

/**
 * Build one {@link TableSchema} from a table NAME and its `@orkestrel/database` `TableExport` —
 * the "deployed" schema shape `DatabaseInterface.migrate` diffs against, derived from a LIVE
 * handle's `export()` rather than a re-declared {@link TableSpec}, so it works for ANY handle
 * (config-tracked or caller-supplied).
 *
 * @param name - The table name
 * @param table - The table's `TableExport` (`{ key, columns }`, `@orkestrel/database`)
 * @returns The equivalent {@link TableSchema} (`indexes` empty — this package declares none)
 */
export function tableSchema(
	name: string,
	table: Readonly<{ key: string; columns: Readonly<Record<string, ContractShape>> }>,
): TableSchema {
	return {
		name,
		primary: table.key,
		columns: Object.entries(table.columns).map(([column, shape]) => columnSchema(column, shape)),
		indexes: [],
	}
}
