import type { WorkflowDefinition, WorkflowResult } from '@orkestrel/workflow'
import type { DatabaseErrorCode } from '@orkestrel/database'
import type {
	Include,
	ModelInterface,
	RelationErrorCode,
	RelationManagerInterface,
} from '@orkestrel/relation'
import type { QueryInput } from '@orkestrel/database'
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
import { ToolboxError } from './errors.js'
import { isWorkflowLineage } from './validators.js'

// Toolbox owns the workflow tool's lenient-authoring completion, ancestry tags, and boundary
// projections. Runtime scheduling, named-function resolution, and persistence remain native
// `@orkestrel/workflow` responsibilities.

/**
 * Returns the ancestry identifier of a workflow in a run chain — `workflow:<id>`.
 *
 * @remarks
 * Namespacing keeps a workflow id and a {@link tagAgent} agent name in ONE set without
 * collision, so re-entering a workflow OR an agent already in the chain is a single `includes`
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
 * Builds the plain success summary {@link import('./factories.js').createWorkflowTool} returns on
 * a completed run — the universal tool-handler contract: return a plain value on success,
 * appearing identically over BOTH the agent loop and MCP.
 *
 * @remarks
 * The summary is LEAN: the workflow's terminal `status`, settled-task count, and exact optional
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

// === Draft completion + flat-steps expansion (the tool's LENIENT authoring surfaces)
//
// Pure, deterministic synthesis that turns a WIDENED authoring form into a strict
// `WorkflowDefinition` (`@orkestrel/workflow`). They auto-fill only OMITTED identity (a provided
// id/name is preserved verbatim; an explicitly-empty `id: ''` is rejected UPSTREAM by the draft
// contract, never reached here), so a small model can author a complete tree without emitting
// the six required `id`/`name` strings. The factory re-validates the result against the STRICT
// `createWorkflowContract().is` gate before running (soundness).

/**
 * Completes a {@link WorkflowDraft} into a strict {@link WorkflowDefinition} — synthesizes any
 * MISSING `id` deterministically + positionally, and defaults any MISSING `name` to its
 * (now-resolved) `id`.
 *
 * @remarks
 * The positional id scheme is stable and human-legible: the workflow is `wf`, phase `i` is
 * `phase-<i>`, and task `j` of that phase is `<phaseId>-task-<j>` (so a provided phase id flows
 * into its tasks' synthesized ids). A PROVIDED `id` / `name` at any level is kept VERBATIM —
 * synthesis touches only the omitted ones. A missing `name` defaults to the resolved `id` (never
 * the other way round), so the result always has both. `behavior`, `description`, the per-phase
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
 * becomes a one-task phase, IN ORDER.
 *
 * @remarks
 * The expansion of the tool's ADVERTISED surface: the deliberately-reduced flat form. Each
 * {@link import('./types.js').WorkflowStep} maps to a phase holding exactly one task: the step's
 * `name` becomes the task's `behavior` (the behavior-registry key). Ids/names are auto-filled
 * positionally — it builds an ids-omitted {@link WorkflowDraft} and delegates to
 * {@link completeDraft}, so the two lenient surfaces share ONE synthesis path (step `i` → phase
 * `phase-<i>`, its task `phase-<i>-task-0`). The optional `name` becomes both the workflow's
 * deterministic id and its name, so named flat workflows retain distinct persistence keys;
 * omission keeps the shared draft fallback `wf`. The result is a complete definition the caller
 * validates against the STRICT contract before running.
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
 * Expands the relation tool's FLAT dot-path `include` list into a live `@orkestrel/relation`
 * {@link Include} tree — the pure leaf {@link import('./factories.js').createRelationTool} calls
 * before a `'load'` / `'find'` call.
 *
 * @remarks
 * Each path splits on `'.'` into a chain of relation names, deep-merged into one nested
 * `Include` object with a leaf `true`. A longer path SUBSUMES a shorter sibling's bare `true` —
 * `'contacts'` followed by `'contacts.account'` yields `{ contacts: { account: true } }`, never
 * overwriting the deeper chain. An EMPTY segment (`''`, from a leading/trailing/doubled `.`) or a
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
	let include: Include = {}
	for (const path of paths ?? []) {
		const segments = path.split('.')
		if (segments.length > depth || segments.some((segment) => segment.length === 0)) {
			throw new ToolboxError('TOOL', `malformed include path '${path}'`, { path, depth })
		}
		const ancestors: Include[] = []
		let branch = include
		const last = segments.length - 1
		for (let index = 0; index < last; index++) {
			const segment = segments[index]
			if (segment === undefined) {
				throw new ToolboxError('TOOL', `malformed include path '${path}'`, { path, depth })
			}
			ancestors.push(branch)
			const existing = branch[segment]
			branch = typeof existing === 'object' ? existing : {}
		}
		const leaf = segments[last]
		if (leaf === undefined) {
			throw new ToolboxError('TOOL', `malformed include path '${path}'`, { path, depth })
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
				throw new ToolboxError('TOOL', `malformed include path '${path}'`, { path, depth })
			}
			merged = { ...ancestor, [segment]: merged }
		}
		include = merged
	}
	return include
}

/**
 * Resolves which registered {@link RelationManagerInterface} a relation-tool call addresses — the
 * pure manager-resolution leaf {@link import('./factories.js').createRelationTool} calls on
 * every operation.
 *
 * @remarks
 * An explicit `name` must match a key of `managers` (a miss throws a typed `TOOL`
 * {@link ToolboxError} naming the registered managers). An OMITTED `name` resolves to the sole
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
			throw new ToolboxError('TOOL', `unknown relation manager '${name}'`, {
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
	throw new ToolboxError('TOOL', 'no relation manager resolved for the call', {
		managers: names,
	})
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
		throw new ToolboxError('TOOL', `unknown model '${name}'`, {
			model: name,
			models: manager.names(),
		})
	}
	return manager.model(name)
}

// === Database-tool operation leaves

/**
 * Returns the canonical live `@orkestrel/database` {@link QueryInput} for the database tool's
 * parsed SERIALIZED query — each condition's OMITTED `connector` defaults to `'and'`.
 *
 * @remarks
 * The wire form ({@link import('./shapers.js').databaseToolShape}) lets a caller drop `connector`
 * on the last condition (it has nothing to join FORWARD to); the compiled `Condition` a live
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
 * Clamps a `'records'` call's query to a row cap, and builds the PROBE query the caller reads
 * with — the pure leaf {@link import('./factories.js').createDatabaseTool}'s `'records'` operation
 * uses to detect truncation without a separate `count` round trip.
 *
 * @remarks
 * {@link resolveLimit} picks the effective limit, so a caller can never exceed the configured cap
 * by supplying a larger `query.limit`, and can never drive it below `0`. The returned probe query
 * requests ONE MORE row than the effective limit (`limit: effective + 1`) — if storage returns
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
 * @returns The PROBE query (`limit` bumped by one) and the effective `limit`
 */
export function clampQuery(query: QueryInput | undefined, cap: number): ClampedQuery {
	const limit = resolveLimit(query?.limit, cap)
	return { query: { ...query, limit: limit + 1 }, limit }
}
