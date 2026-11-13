import type { WorkflowDefinition, WorkflowResult } from '@orkestrel/workflow'
import type { DatabaseErrorCode } from '@orkestrel/database'
import type {
	Include,
	ModelInterface,
	RelationErrorCode,
	RelationManagerInterface,
} from '@orkestrel/relation'
import type { QueryInput } from '@orkestrel/database'
import type { WorkspaceInterface, WorkspaceManagerInterface } from '@orkestrel/workspace'
import type { AgentCaller } from '@orkestrel/agent'
import type {
	ToolboxErrorCode,
	ClampedQuery,
	DatabaseQueryInput,
	WorkflowToolResult,
	WorkflowLineage,
} from './types.js'
import type { PhaseDraft, TaskDraft, WorkflowDraft, WorkflowSteps } from './types.js'
import { isTerminalError } from '@orkestrel/terminal'
import { isDatabaseError } from '@orkestrel/database'
import { isRelationError } from '@orkestrel/relation'
import type { AuditFault, ContractInterface, JSONRecord, JSONSchema } from '@orkestrel/contract'
import {
	admitValue,
	attempt,
	createContract,
	describeFaults,
	extractPath,
	FAULT_TEXT_LIMIT,
	isArray,
	isObject,
	isRecord,
	matchesExactKeys,
	preview,
	renderList,
	schemaToShape,
} from '@orkestrel/contract'
import { isAgentCaller, isPositiveSafeInteger } from '@orkestrel/agent'
import { ToolError } from '@orkestrel/tool'
import { ToolboxError } from './errors.js'
import { isWorkflowLineage } from './validators.js'

// Toolbox owns the workflow tool's lenient-authoring completion, ancestry tags, and boundary
// projections. Runtime scheduling, named-function resolution, and persistence remain native
// `@orkestrel/workflow` responsibilities.

/**
 * Returns the ancestry identifier of a workflow in a run chain — `workflow:<id>`.
 *
 * @remarks
 * Namespacing keeps a workflow id and a {@link tagAgent} agent name in one set without
 * collision, so re-entering a workflow or an agent already in the chain is a single `includes`
 * check.
 *
 * @param id - The workflow definition's `id`
 * @returns The namespaced ancestry tag (`workflow:<id>`)
 */
export function tagWorkflow(id: string): string {
	return `workflow:${id}`
}

/**
 * Returns the ancestry identifier of an agent in a run chain — `agent:<name>`.
 *
 * @remarks
 * The agent counterpart of {@link tagWorkflow}: {@link import('./factories.js').createAgentFunction}
 * / {@link import('./factories.js').createWorkflowTool} guard against re-entering an agent or
 * workflow already in the chain (this package's typed `DEPTH` `ToolboxError`). The
 * `agent:` namespace keeps it distinct from a same-string workflow id.
 *
 * @param name - The agent's identifier / registry name
 * @returns The namespaced ancestry tag (`agent:<name>`)
 */
export function tagAgent(name: string): string {
	return `agent:${name}`
}

/**
 * Returns the canonical workflow lineage — validated, copied, and frozen.
 *
 * @param lineage - The configured chain; omitted means a direct root
 * @returns An immutable caller-isolated lineage
 */
export function normalizeLineage(lineage: WorkflowLineage = []): WorkflowLineage {
	if (!isWorkflowLineage(lineage)) {
		throw new ToolboxError('TOOL', 'workflow lineage must alternate unique workflow and agent tags')
	}
	return Object.freeze([...lineage])
}

/**
 * Appends one tag to a workflow lineage and returns a frozen copy.
 *
 * @param lineage - The valid chain to extend
 * @param tag - The workflow or agent tag to append
 * @returns The validated immutable extension
 */
export function extendLineage(lineage: WorkflowLineage, tag: string): WorkflowLineage {
	return normalizeLineage([...lineage, tag])
}

/**
 * Derives the zero-based workflow nesting depth from a valid lineage.
 *
 * @param lineage - The workflow/agent chain
 * @returns Zero for an empty/root lineage, then one per nested workflow
 */
export function deriveWorkflowDepth(lineage: WorkflowLineage): number {
	const current = normalizeLineage(lineage)
	const workflows = current.filter((tag) => tag.startsWith('workflow:')).length
	return Math.max(0, workflows - 1)
}

/**
 * Builds the plain success summary {@link import('./factories.js').createWorkflowTool} returns on a
 * completed run — the universal tool-handler contract: return a plain value on success, appearing
 * identically over both the agent loop and MCP.
 *
 * @remarks
 * The summary is lean: the workflow's terminal `status`, settled-task count, and exact optional
 * native persistence outcome. It carries no synthetic `id` / `name`: a tool handler has no call
 * id; the `ToolManagerInterface` (`@orkestrel/tool`) supplies the canonical envelope's identity.
 *
 * @param result - The terminal `WorkflowResult` (`@orkestrel/workflow`) the run produced
 * @returns The plain success summary — `{ status, count, durable?, fault? }`
 */
export function summarizeWorkflow(result: WorkflowResult): WorkflowToolResult {
	return {
		status: result.status,
		count: result.results.length,
		...(result.durable === undefined ? {} : { durable: result.durable }),
		...(result.fault === undefined ? {} : { fault: result.fault }),
	}
}

// === Draft completion and flat-steps expansion (the tool's lenient authoring surfaces)
//
// Pure, deterministic synthesis that turns a widened authoring form into a strict
// `WorkflowDefinition` (`@orkestrel/workflow`). They auto-fill only omitted identity (a provided
// id/name is preserved verbatim; an explicitly-empty `id: ''` is rejected upstream by the draft
// contract, never reached here), so a small model can author a complete tree without emitting an
// `id` or a `name` anywhere in it. The factory re-validates the result against the strict
// `createWorkflowContract().is` gate before running (soundness).

/**
 * Completes a {@link WorkflowDraft} into a strict {@link WorkflowDefinition} — synthesizes a
 * missing `id` deterministically and positionally, and defaults a missing `name` to its resolved
 * `id`.
 *
 * @remarks
 * The positional id scheme is stable and human-legible: the workflow is `wf`, phase `i` is
 * `phase-<i>`, and task `j` of that phase is `<phaseId>-task-<j>` (so a provided phase id flows
 * into its tasks' synthesized ids). A provided `id` / `name` at any level is kept verbatim —
 * synthesis touches only the omitted ones. A missing `name` defaults to the resolved `id` (never
 * the other way round), so the result always carries an `id` and a `name`. `behavior`, `description`, the per-phase
 * `concurrency` / `bail`, the per-task `retries` / `timeout`, and the workflow `bail` carry over
 * unchanged. The result is a complete {@link WorkflowDefinition}; the caller still validates it
 * against the strict contract.
 *
 * @param draft - The draft workflow (`id` and `name` optional at the workflow, phase, and task levels)
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
 * Completes one {@link PhaseDraft} into a strict phase definition — the per-phase step of
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
 * Completes one {@link TaskDraft} into a strict task definition — the per-task leaf step of
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
		...(task.behavior === undefined ? {} : { behavior: task.behavior }),
		...(task.retries === undefined ? {} : { retries: task.retries }),
		...(task.timeout === undefined ? {} : { timeout: task.timeout }),
	}
}

/**
 * Expands a flat {@link WorkflowSteps} blob into a strict {@link WorkflowDefinition} — each step
 * becomes a one-task phase, in order.
 *
 * @remarks
 * The expansion of the tool's advertised surface: the deliberately-reduced flat form. Each
 * {@link import('./types.js').WorkflowStep} maps to a phase holding exactly one task: the step's
 * `name` becomes the task's `behavior` (the behavior-registry key). Ids/names are auto-filled
 * positionally — it builds an ids-omitted {@link WorkflowDraft} and delegates to
 * {@link completeDraft}, so the lenient surfaces share one synthesis path (step `i` → phase
 * `phase-<i>`, its task `phase-<i>-task-0`). The optional `name` becomes both the workflow's
 * deterministic id and its name, so named flat workflows retain distinct persistence keys;
 * omission keeps the shared draft fallback `wf`. The result is a complete definition the caller
 * validates against the strict contract before running.
 *
 * @param flat - The flat steps blob (`{ name?, steps: [{ name }] }`)
 * @returns A complete {@link WorkflowDefinition} (one one-task phase per step)
 */
export function expandSteps(flat: WorkflowSteps): WorkflowDefinition {
	return completeDraft({
		...(flat.name === undefined ? {} : { id: flat.name, name: flat.name }),
		phases: flat.steps.map((step) => ({
			tasks: [{ behavior: step.name }],
		})),
	})
}

/**
 * Maps a caught error to the {@link ToolboxErrorCode} the terminal-tool factory throws with — the
 * pure classification step of that factory's error handling.
 *
 * @remarks
 * Narrows `error` with {@link isTerminalError} (`@orkestrel/terminal`) first: a non-`TerminalError`
 * value returns `undefined`, telling the caller this mapper does not apply (rethrow / handle
 * otherwise). For a genuine `TerminalError`, `'DEADLOCK'` maps to `'DEADLOCK'`, `'EXPIRE'` maps
 * to `'EXPIRE'`, and every other {@link import('@orkestrel/terminal').TerminalErrorCode}
 * (`'TARGET'`, `'LIMIT'`, `'CANCEL'`, `'DRIVER'`, `'DESTROYED'`) maps to the generic `'TOOL'`
 * code. The mapper only classifies — the factory performs the actual throw.
 *
 * @param error - The value caught from a terminal-manager operation (`ask` / `answer` / …)
 * @returns The mapped {@link ToolboxErrorCode}, or `undefined` if `error` is not a `TerminalError`
 */
export function inferTerminalCode(error: unknown): ToolboxErrorCode | undefined {
	if (!isTerminalError(error)) return undefined
	if (error.code === 'DEADLOCK') return 'DEADLOCK'
	if (error.code === 'EXPIRE') return 'EXPIRE'
	return 'TOOL'
}

// === Database- and relation-tool error classification — a caught upstream error maps to the
// code the owning factory re-throws with.

/**
 * Maps a caught error to the granular {@link DatabaseErrorCode} (`@orkestrel/database`) the code
 * {@link import('./factories.js').createDatabaseTool} throws with — the pure classification step
 * of that factory's error handling, mirroring {@link inferTerminalCode}'s idiom for
 * `@orkestrel/database`.
 *
 * @param error - The value caught from a `@orkestrel/database` table operation
 * @returns The granular {@link DatabaseErrorCode}, or `undefined` if `error` is not a `DatabaseError`
 */
export function inferDatabaseCode(error: unknown): DatabaseErrorCode | undefined {
	return isDatabaseError(error) ? error.code : undefined
}

/**
 * Maps a caught error to the granular {@link RelationErrorCode} (`@orkestrel/relation`) the code
 * {@link import('./factories.js').createRelationTool} throws with — the pure classification step
 * of that factory's error handling, mirroring {@link inferTerminalCode}'s idiom for
 * `@orkestrel/relation`.
 *
 * @param error - The value caught from a `@orkestrel/relation` operation
 * @returns The granular {@link RelationErrorCode}, or `undefined` if `error` is not a `RelationError`
 */
export function inferRelationCode(error: unknown): RelationErrorCode | undefined {
	return isRelationError(error) ? error.code : undefined
}

/**
 * Expands the relation tool's flat dot-path `include` list into a live `@orkestrel/relation`
 * {@link Include} tree — the pure leaf {@link import('./factories.js').createRelationTool} calls
 * before a `'load'` / `'find'` call.
 *
 * @remarks
 * Each path splits on `'.'` into a chain of relation names, deep-merged into one nested
 * `Include` object with a leaf `true`. A longer path subsumes a shorter sibling's bare `true` —
 * `'contacts'` followed by `'contacts.account'` yields `{ contacts: { account: true } }`, never
 * overwriting the deeper chain. An empty segment (`''`, from a leading/trailing/doubled `.`) or a
 * path whose segment count exceeds `depth` throws a typed `TOOL` {@link ToolboxError}.
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
	return Iterator.from(paths ?? []).reduce<Include>((include, path) => {
		const segments = path.split('.')
		if (segments.length > depth || segments.some((segment) => segment.length === 0)) {
			throw new ToolboxError(
				'TOOL',
				`malformed include path ${preview(path)}; send dot-separated relation names with no empty segment and at most ${String(depth)} segments`,
				{ path, depth },
			)
		}
		const ancestors: Include[] = [include]
		const last = segments.length - 1
		for (const [index, segment] of segments.entries()) {
			if (index === last) break
			const branch = ancestors.at(-1)
			if (branch === undefined)
				throw new ToolboxError('TOOL', `malformed include path '${path}'`, { path, depth })
			const existing = branch[segment]
			ancestors.push(isObject(existing) ? existing : {})
		}
		const leaf = segments[last]
		const branch = ancestors.at(-1)
		if (leaf === undefined || branch === undefined) {
			throw new ToolboxError('TOOL', `malformed include path '${path}'`, { path, depth })
		}
		const existing = branch[leaf]
		return ancestors.slice(0, -1).reduceRight<Include>(
			(merged, ancestor, index) => {
				const segment = segments[index]
				if (segment === undefined)
					throw new ToolboxError('TOOL', `malformed include path '${path}'`, { path, depth })
				return { ...ancestor, [segment]: merged }
			},
			{ ...branch, [leaf]: existing === undefined ? true : existing },
		)
	}, {})
}

/**
 * Resolves which registered {@link RelationManagerInterface} a relation-tool call addresses — the
 * pure manager-resolution leaf {@link import('./factories.js').createRelationTool} calls on
 * every operation.
 *
 * @remarks
 * An explicit `name` must match a key of `managers` (a miss throws a typed `TOOL`
 * {@link ToolboxError} naming the registered managers). An omitted `name` resolves to the sole
 * registered manager when exactly one is registered, else throws the same typed error.
 *
 * @param managers - The tool's registered `RelationManagerInterface` map
 * @param name - The call's optional `manager` field
 * @returns The resolved {@link RelationManagerInterface}
 */
export function resolveRelationManager(
	managers: Readonly<Record<string, RelationManagerInterface>>,
	name: string | undefined,
): RelationManagerInterface {
	if (name !== undefined) {
		const manager = managers[name]
		if (manager === undefined) {
			throw new ToolboxError(
				'TOOL',
				`unknown relation manager ${preview(name)}; send manager as one of ${renderCandidates(Object.keys(managers))}`,
				{ manager: name, managers: Object.keys(managers) },
			)
		}
		return manager
	}
	const names = Object.keys(managers)
	const [single] = names
	if (names.length === 1 && single !== undefined) {
		const manager = managers[single]
		if (manager !== undefined) return manager
	}
	throw new ToolboxError(
		'TOOL',
		`no relation manager resolved for the call; send manager as one of ${renderCandidates(names)}`,
		{ managers: names },
	)
}

/**
 * Resolves a `model` name against a live {@link RelationManagerInterface} — the pure model-lookup
 * leaf {@link import('./factories.js').createRelationTool} calls on every operation, mirroring
 * {@link resolveRelationManager}'s guard shape.
 *
 * @param manager - The resolved {@link RelationManagerInterface}
 * @param name - The call's `model` field
 * @returns The model's {@link ModelInterface}
 */
export function resolveRelationModel(
	manager: RelationManagerInterface,
	name: string,
): ModelInterface {
	if (!manager.has(name)) {
		throw new ToolboxError(
			'TOOL',
			`unknown model ${preview(name)}; send model as one of ${renderCandidates(manager.names())}`,
			{ model: name, models: manager.names() },
		)
	}
	return manager.model(name)
}

// === Database-tool operation leaves

/**
 * Returns the canonical live `@orkestrel/database` {@link QueryInput} for the database tool's
 * parsed serialized query — each condition's omitted `connector` defaults to `'and'`.
 *
 * @remarks
 * The wire form ({@link import('./shapers.js').databaseToolShape}) lets a caller drop `connector`
 * on the last condition (it has nothing to join forward to); the compiled `Condition` a live
 * `@orkestrel/database` table call accepts always carries one, so this fills the gap. `order` /
 * `limit` / `offset` pass through unchanged. Pure and total.
 *
 * @param query - The parsed query (or `undefined`)
 * @returns The equivalent live `QueryInput`, or `undefined` when `query` is `undefined`
 */
export function normalizeQuery(query: DatabaseQueryInput | undefined): QueryInput | undefined {
	if (query === undefined) return undefined
	const conditions = query.conditions?.map((condition) => ({
		...condition,
		connector: condition.connector ?? 'and',
	}))
	return {
		...(conditions === undefined ? {} : { conditions }),
		...(query.order === undefined ? {} : { order: query.order }),
		...(query.limit === undefined ? {} : { limit: query.limit }),
		...(query.offset === undefined ? {} : { offset: query.offset }),
	}
}

/**
 * Picks the effective row limit a tool reads with — the requested count when it sits inside the
 * cap, the cap when it exceeds it, and `0` when either falls below zero.
 *
 * @remarks
 * The one place the database tool's `'records'` clamp ({@link clampQuery}) and the relation tool's
 * `'find'` / `'links'` truncation both take their ceiling from, so a negative construction-time
 * option can never reach a slice. Pure and total.
 *
 * @example
 * ```ts
 * import { resolveLimit } from '@src/core'
 *
 * resolveLimit(undefined, 100) // 100 — an omitted request takes the cap
 * resolveLimit(500, 100) // 100 — a request over the cap is clamped down
 * resolveLimit(-1, 100) // 0 — a negative request floors at zero
 * ```
 *
 * @param requested - The caller's requested row count (or `undefined`)
 * @param cap - The row-count ceiling
 * @returns The effective row limit, never below `0` and never above `cap`
 */
export function resolveLimit(requested: number | undefined, cap: number): number {
	return Math.max(0, Math.min(requested ?? cap, cap))
}

/**
 * Clamps a `'records'` call's query to a row cap, and builds the probe query the caller reads with
 * — the pure leaf {@link import('./factories.js').createDatabaseTool}'s `'records'` operation uses
 * to detect truncation without a separate `count` round trip.
 *
 * @remarks
 * {@link resolveLimit} picks the effective limit, so a caller can never exceed the configured cap
 * by supplying a larger `query.limit`, and can never drive it below `0`. The returned probe query
 * requests one more row than the effective limit (`limit: effective + 1`) — if storage returns
 * that many, the caller knows the true result was truncated (`rows.length > effective`) and slices
 * back down to `effective` before returning.
 *
 * @example
 * ```ts
 * import { clampQuery } from '@src/core'
 *
 * const { query, limit } = clampQuery(undefined, 100)
 * // limit === 100, query.limit === 101 — a probe fetching one extra row
 * const rows = await table.records(query)
 * const truncated = rows.length > limit // true when storage had more than `limit` rows
 * ```
 *
 * @param query - The live query to clamp (or `undefined`)
 * @param cap - The row-count ceiling
 * @returns The probe query (`limit` bumped by one) and the effective `limit`
 */
export function clampQuery(query: QueryInput | undefined, cap: number): ClampedQuery {
	const limit = resolveLimit(query?.limit, cap)
	return { query: { ...query, limit: limit + 1 }, limit }
}

/**
 * Resolves an owned workflow input through the supplied flat or draft contracts, or refuses it with
 * what to send.
 *
 * @remarks
 * Empty input is the wrapped definition. A `phases` key with no `steps` key takes the draft form,
 * and everything else takes the advertised flat form, so a blob carrying both keys refuses `phases`
 * as undeclared rather than ignoring it, and a blob carrying neither is told to send `steps`.
 *
 * @param owned - The call's owned JSON arguments
 * @param definition - The wrapped definition empty input runs
 * @param steps - The compiled flat form
 * @param draft - The compiled draft form
 * @returns The definition the input resolves to
 * @throws {import('@orkestrel/tool').ToolError} Thrown with code `ARGUMENTS` when the chosen form refuses the input, carrying `context.faults`
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { completeDraft, createWorkflowDraftContract, resolveWorkflowTarget, workflowStepsShape } from '@src/core'
 *
 * const definition = completeDraft({ phases: [{ tasks: [{}] }] })
 * const steps: import('@orkestrel/contract').ContractInterface<import('./types.js').WorkflowSteps> = createContract(workflowStepsShape)
 * resolveWorkflowTarget({}, definition, steps, createWorkflowDraftContract()) // definition
 * ```
 */
export function resolveWorkflowTarget(
	owned: JSONRecord,
	definition: WorkflowDefinition,
	steps: ContractInterface<WorkflowSteps>,
	draft: ContractInterface<WorkflowDraft>,
): WorkflowDefinition {
	if (Object.keys(owned).length === 0) return definition
	return Object.hasOwn(owned, 'phases') && !Object.hasOwn(owned, 'steps')
		? completeDraft(requireToolCall(draft, owned))
		: expandSteps(requireToolCall(steps, owned))
}

// === Refusal text

/**
 * Renders the candidates a refusal offers, each encoded and length-capped and at most
 * `REFUSAL_LIST_LIMIT` of them named, so a long or multiline name cannot fake or balloon the message.
 *
 * @param names - The candidates to offer
 * @returns The encoded candidates joined with `, `, empty when there are none
 *
 * @example
 * ```ts
 * import { renderCandidates } from '@src/core'
 *
 * renderCandidates(['read', 'list']) // '"read", "list"'
 * ```
 */
export function renderCandidates(names: readonly string[]): string {
	return renderList(names.map((name) => preview(name)))
}

/**
 * Caps the complete text of a refusal at `FAULT_TEXT_LIMIT` characters, saying where it stopped.
 *
 * @remarks
 * A refusal goes back to a model whose context window can be small. Use this where a message joins
 * parts this package cannot bound one by one: a head beside a report, or an upstream error's text.
 *
 * @param text - The refusal text
 * @returns The text unchanged when it fits, otherwise cut to the limit and well formed
 *
 * @example
 * ```ts
 * import { limitRefusal } from '@src/core'
 *
 * limitRefusal('send steps') // 'send steps'
 * limitRefusal('x'.repeat(5000)).length // 2048
 * ```
 */
export function limitRefusal(text: string): string {
	if (text.length <= FAULT_TEXT_LIMIT) return text
	const closing = '… the message stops here; correct what it names and call again'
	return `${text.slice(0, FAULT_TEXT_LIMIT - closing.length).toWellFormed()}${closing}`
}

// === Tool-call doors

/**
 * Reads a call's arguments through a compiled contract, or refuses them with what to send.
 *
 * @remarks
 * Uses the contract admission door and translates refusals to tool errors.
 * Tools with object and union roots enforce `createTool`'s `contract` and use this helper to type
 * the parsed arguments. The workflow tool uses this door under `strict: false` because it accepts
 * several authoring forms while advertising the flat form.
 *
 * @param contract - The compiled contract of the arguments
 * @param value - The arguments the call sent
 * @returns The admitted value, which may retain input identity under a union
 * @throws {import('@orkestrel/tool').ToolError} Thrown with code `ARGUMENTS`, carrying `context.faults` when the arguments could be read
 *
 * @example
 * ```ts
 * import { createContract, numberShape, objectShape } from '@orkestrel/contract'
 * import { requireToolCall } from '@src/core'
 *
 * const contract = createContract(objectShape({ amount: numberShape() }))
 * requireToolCall(contract, { amount: '3' }) // { amount: 3 }
 * requireToolCall(contract, { amount: 3, extra: 1 }) // throws ToolError ('ARGUMENTS')
 * ```
 */
export function requireToolCall<T>(contract: ContractInterface<T>, value: unknown): T {
	const read = admitValue(contract, value)
	if (!read.success) {
		if (read.error.cause === undefined)
			throw buildArgumentRefusal(contract.schema, value, read.error.faults)
		throw new ToolError(
			'ARGUMENTS',
			'Arguments could not be read; send one JSON object of plain values',
			undefined,
			{ cause: read.error.cause },
		)
	}
	return read.value.value
}

/**
 * Builds an argument refusal from the supplied faults, auditing the schema when no faults were supplied.
 *
 * @remarks
 * Uses the contract's union reporting: a selected arm names its own faults, and a value selecting
 * no arm receives a bounded summary of alternatives. Supplied faults remain unchanged.
 *
 * @param schema - The compiled schema the arguments are held to
 * @param value - The arguments the call sent
 * @param faults - The faults admission reported
 * @returns The `ToolError` to throw, with code `ARGUMENTS` and the faults in `context.faults`
 *
 * @example
 * ```ts
 * import { createContract, literalShape, objectShape, stringShape, unionShape } from '@orkestrel/contract'
 * import { buildArgumentRefusal } from '@src/core'
 *
 * const { schema } = createContract(
 * 	unionShape(
 * 		objectShape({ operation: literalShape(['read']), path: stringShape() }),
 * 		objectShape({ operation: literalShape(['list']) }),
 * 	),
 * )
 * buildArgumentRefusal(schema, { operation: 'read' }, []).message
 * // 'path: missing; expected string'
 * ```
 */
export function buildArgumentRefusal(
	schema: JSONSchema,
	value: unknown,
	faults: readonly AuditFault[],
): ToolError {
	const listed = faults.length === 0 ? createContract(schemaToShape(schema)).audit(value) : faults
	return new ToolError('ARGUMENTS', describeFaults(listed, schema), { faults: listed })
}

/**
 * Picks the effective value of a positive numeric tool option: the configured value when it is a
 * positive safe integer, and the fallback when it is omitted.
 *
 * @param value - The configured option, or `undefined`
 * @param fallback - The default an omitted option takes
 * @param subject - The name the refusal gives the option
 * @returns The effective value
 * @throws {ToolboxError} Thrown with code `TOOL` when `value` is present and is anything else, because `NaN` as a bound passes every comparison
 *
 * @example
 * ```ts
 * import { resolveBound } from '@src/core'
 *
 * resolveBound(undefined, 100, 'database limit') // 100
 * resolveBound(25, 100, 'database limit') // 25
 * resolveBound(0, 100, 'database limit') // throws ToolboxError ('TOOL')
 * ```
 */
export function resolveBound(value: number | undefined, fallback: number, subject: string): number {
	if (value === undefined) return fallback
	if (isPositiveSafeInteger(value)) return value
	throw new ToolboxError(
		'TOOL',
		`${subject} must be a positive safe integer; received ${preview(value)}; omit it for the default ${String(fallback)}`,
		{ received: preview(value) },
	)
}

// === Workspace tool caller

/**
 * Reads the caller a workspace tool call carries as an owned `AgentCaller`, refusing a value that
 * holds a `workspace` key and is not one.
 *
 * @remarks
 * A value that is no object, or an object that holds no `workspace` key, own or inherited, is no
 * Agent caller and reads as `undefined`. An object that holds that key must be a plain record
 * (`isRecord`, `@orkestrel/contract`) that owns exactly `workspace` and `files`, and the copy built
 * from one read of each, its `files` array copied once, must pass `isAgentCaller`
 * (`@orkestrel/agent`). Anything else refuses: a class instance, a caller whose members sit on its
 * prototype, and an object whose keys or members cannot be read. A malformed caller never falls
 * back to the host's selection. Each member is read once into the frozen copy the call uses, so a
 * member that answers differently on a later read is accepted as that one reading and cannot change
 * what the call acts on.
 *
 * @param value - The `caller` member of the call's `ToolContext`
 * @returns A frozen copy of the caller when it is an `AgentCaller`, otherwise `undefined`
 * @throws {ToolboxError} Thrown with code `TOOL` when the value holds a `workspace` key, own or inherited, and is no `AgentCaller`
 *
 * @example
 * ```ts
 * import { readToolCaller } from '@src/core'
 *
 * readToolCaller(undefined) // undefined
 * readToolCaller({ subject: 'reader' }) // undefined
 * readToolCaller({ workspace: undefined, files: ['notes.md'] }) // { workspace: undefined, files: ['notes.md'] }
 * readToolCaller({ workspace: 'returns' }) // throws ToolboxError ('TOOL')
 * ```
 */
export function readToolCaller(value: unknown): AgentCaller | undefined {
	if (!isObject(value)) return undefined
	const read = attempt(() => {
		if (!('workspace' in value)) return { claimed: false, caller: undefined }
		if (!isRecord(value) || !matchesExactKeys(value, ['workspace', 'files'])) {
			return { claimed: true, caller: undefined }
		}
		const files: unknown = Reflect.get(value, 'files')
		return {
			claimed: true,
			caller: Object.freeze({
				workspace: Reflect.get(value, 'workspace'),
				files: isArray(files) ? Object.freeze([...files]) : files,
			}),
		}
	})
	if (read.success && !read.value.claimed) return undefined
	if (read.success && read.value.caller !== undefined && isAgentCaller(read.value.caller)) {
		return read.value.caller
	}
	throw new ToolboxError(
		'TOOL',
		'context.caller holds a "workspace" key and is no AgentCaller; an AgentCaller is a plain record that owns exactly "workspace" (a workspace or undefined) and "files" (an array of paths or undefined), so this call reads and edits nothing',
	)
}

/**
 * Resolves the workspace a workspace tool call acts on: the Agent caller's workspace when it is an
 * instance the tool's manager holds, `undefined` for a run that shows none, and the manager's
 * active workspace when no Agent caller is present.
 *
 * @remarks
 * The caller's workspace is compared by identity with the manager's own workspaces and never read,
 * so a value that crossed a wire, a copy, or a `Proxy` object over a registered workspace refuses
 * rather than selecting one.
 *
 * @param manager - The manager the workspace tool drives
 * @param caller - The caller {@link readToolCaller} read, or `undefined` when the call has no Agent caller
 * @returns The workspace the call acts on, or `undefined` when it acts on none
 * @throws {ToolboxError} Thrown with code `TOOL` when the caller's workspace is not one the manager holds
 *
 * @example
 * ```ts
 * import { createWorkspaceManager } from '@orkestrel/workspace'
 * import { resolveToolWorkspace } from '@src/core'
 *
 * const manager = createWorkspaceManager()
 * const orders = manager.add({ id: 'orders' })
 * const returns = manager.add({ id: 'returns' })
 * resolveToolWorkspace(manager, undefined) === orders // true
 * resolveToolWorkspace(manager, { workspace: returns, files: undefined }) === returns // true
 * resolveToolWorkspace(manager, { workspace: undefined, files: undefined }) // undefined
 * ```
 */
export function resolveToolWorkspace(
	manager: WorkspaceManagerInterface,
	caller: AgentCaller | undefined,
): WorkspaceInterface | undefined {
	if (caller === undefined) return manager.active
	const workspace = caller.workspace
	if (workspace === undefined || manager.workspaces().includes(workspace)) return workspace
	throw new ToolboxError(
		'TOOL',
		"the run's workspace is not one this tool's manager holds; register the workspace tool over the agent's context.workspaces, as createWorkspaceTool({ manager: agent.context.workspaces }) does",
	)
}

/**
 * Returns the workspace an operation that needs one acts on, or refuses with what the caller can do.
 *
 * @param workspace - The workspace {@link resolveToolWorkspace} resolved, or `undefined`
 * @param caller - The Agent caller, or `undefined` when the call has none
 * @param operation - The operation that needs a workspace
 * @returns The workspace
 * @throws {ToolboxError} Thrown with code `TOOL` when `workspace` is `undefined`, and creates none
 *
 * @example
 * ```ts
 * import { createWorkspaceManager } from '@orkestrel/workspace'
 * import { requireToolWorkspace } from '@src/core'
 *
 * const workspace = createWorkspaceManager().add()
 * requireToolWorkspace(workspace, undefined, 'remove') === workspace // true
 * requireToolWorkspace(undefined, undefined, 'remove') // throws ToolboxError ('TOOL')
 * ```
 */
export function requireToolWorkspace(
	workspace: WorkspaceInterface | undefined,
	caller: AgentCaller | undefined,
	operation: string,
): WorkspaceInterface {
	if (workspace !== undefined) return workspace
	throw new ToolboxError(
		'TOOL',
		caller === undefined
			? `operation ${preview(operation)} needs an active workspace and none is; call "write" to create one`
			: `operation ${preview(operation)} needs a workspace and the run shows none; the host selects the workspace a run shows`,
		{ operation },
	)
}

/**
 * Refuses a path the caller's files list omits, with one text whether or not a file sits there.
 *
 * @remarks
 * `files` is three-way: `undefined` admits every path, `[]` admits none, and a list admits its
 * members. The refusal names the path and at most `REFUSAL_LIST_LIMIT` of the listed paths, each
 * encoded and length-capped, and never says whether the workspace holds the path.
 *
 * @param files - The caller's files list, or `undefined` when it states none
 * @param path - The path an operation names
 * @throws {ToolboxError} Thrown with code `TOOL` when `files` is defined and omits `path`
 *
 * @example
 * ```ts
 * import { requireListedPath } from '@src/core'
 *
 * requireListedPath(undefined, 'secret.md') // returns
 * requireListedPath(['notes.md'], 'notes.md') // returns
 * requireListedPath(['notes.md'], 'secret.md') // throws ToolboxError ('TOOL')
 * ```
 */
export function requireListedPath(files: readonly string[] | undefined, path: string): void {
	if (files === undefined || files.includes(path)) return
	throw new ToolboxError(
		'TOOL',
		`path ${preview(path)} is outside the files this run reaches; ${files.length === 0 ? 'this run reaches no file' : `name one of ${renderCandidates(files)}`}`,
		{ path },
	)
}

/**
 * Describes a stored definition that names another id, naming the id it holds and the id it must hold.
 *
 * @param id - The database id the row is stored under
 * @param held - The id the stored definition names
 * @returns The refusal message
 *
 * @example
 * ```ts
 * import { describeDefinitionMismatch } from '@src/core'
 *
 * describeDefinitionMismatch('shop', 'other')
 * // 'database "shop" holds a definition that names id "other"; its id must be "shop"; ...'
 * ```
 */
export function describeDefinitionMismatch(id: string, held: string): string {
	const required = preview(id)
	return `database ${required} holds a definition that names id ${preview(held)}; its id must be ${required}; read the row through your own table and set its id to ${required}, or delete it with store.delete(${required})`
}

/**
 * Describes a stored definition this package refuses to read, naming its first fault and the remedy.
 *
 * @param id - The database id the row is stored under
 * @param faults - The refused definition's faults
 * @returns The refusal message
 *
 * @example
 * ```ts
 * import { describeDefinitionRefusal } from '@src/core'
 *
 * describeDefinitionRefusal('shop', [{ reason: 'extra', path: ['keys'] }])
 * // 'database "shop" holds a definition this version refuses (extra key "keys" at the root; ...'
 * ```
 */
export function describeDefinitionRefusal(id: string, faults: readonly AuditFault[]): string {
	const [first] = faults
	const path = first === undefined ? [] : extractPath(first)
	const held = preview(id)
	const finding =
		first?.reason === 'extra'
			? `extra key ${preview(path.at(-1))} at ${path.length === 1 ? 'the root' : preview(path.slice(0, -1).join('.'))}`
			: first === undefined
				? 'a value its shape cannot name'
				: `${first.reason} at ${path.length === 0 ? 'the root' : preview(path.join('.'))}`
	const remedy =
		first?.reason === 'extra' ? 'rewrite it without the key' : 'rewrite it to the declared shape'
	return `database ${held} holds a definition this version refuses (${finding}; a definition written before this change can carry it); read the row through your own table and ${remedy}, or delete it with store.delete(${held})`
}
