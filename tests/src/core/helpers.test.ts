import type { QueryInput } from '@orkestrel/database'
import type { WorkflowDraft, WorkflowSteps } from '@src/core'
import type {
	LifecycleStatus,
	TaskResult,
	WorkflowDefinition,
	WorkflowResult,
} from '@orkestrel/workflow'
import {
	tagAgent,
	ToolboxError,
	clampQuery,
	completeDraft,
	completePhaseDraft,
	completeTaskDraft,
	deriveWorkflowDepth,
	extendLineage,
	normalizeLineage,
	normalizeQuery,
	inferDatabaseCode,
	expandInclude,
	expandSteps,
	isToolboxError,
	inferRelationCode,
	resolveLimit,
	inferTerminalCode,
	tagWorkflow,
	summarizeWorkflow,
} from '@src/core'
import { TerminalError } from '@orkestrel/terminal'
import {
	buildPhaseContext,
	buildTaskContext,
	buildWorkflowContext,
	createWorkflow,
	createWorkflowContract,
} from '@orkestrel/workflow'
import { DatabaseError } from '@orkestrel/database'
import { RelationError } from '@orkestrel/relation'
import { describe, expect, it } from 'vitest'

// tests/src/core/helpers.test.ts — mirrors src/core/helpers.ts. Pure, deterministic
// synthesis (AGENTS' no-mocks rule: real inputs, no mocks): the ancestry tag namespacing, the
// workflow-tool run summary, and the draft-completion / flat-steps-expansion pipeline
// that turns the tool's LENIENT authoring surfaces into a strict WorkflowDefinition
// (`@orkestrel/workflow`).

describe('ancestry tags — tagWorkflow / tagAgent (depth/cycle chain identifiers)', () => {
	it('namespaces a workflow id and an agent name distinctly (no collision)', () => {
		expect(tagWorkflow('x')).toBe('workflow:x')
		expect(tagAgent('x')).toBe('agent:x')
		expect(tagWorkflow('x')).not.toBe(tagAgent('x'))
	})

	it('is a pure function of its input id/name', () => {
		expect(tagWorkflow('release')).toBe('workflow:release')
		expect(tagAgent('reviewer')).toBe('agent:reviewer')
	})
})

describe('workflow lineage helpers', () => {
	it('copies and freezes construction and extension without aliasing caller arrays', () => {
		const source = ['workflow:root']
		const root = normalizeLineage(source)
		source.push('agent:later')
		const nested = extendLineage(root, 'agent:a')
		expect(root).toEqual(['workflow:root'])
		expect(nested).toEqual(['workflow:root', 'agent:a'])
		expect(Object.isFrozen(root)).toBe(true)
		expect(Object.isFrozen(nested)).toBe(true)
	})

	it('throws TOOL for malformed configured chains', () => {
		for (const lineage of [
			['agent:a'],
			['workflow:a', 'workflow:b'],
			['workflow:a', 'agent:b', 'workflow:a'],
		]) {
			let error: unknown
			try {
				normalizeLineage(lineage)
			} catch (caught) {
				error = caught
			}
			expect(isToolboxError(error) ? error.code : undefined).toBe('TOOL')
		}
	})

	it('derives uniform zero-based workflow depth', () => {
		expect(deriveWorkflowDepth([])).toBe(0)
		expect(deriveWorkflowDepth(['workflow:root'])).toBe(0)
		expect(deriveWorkflowDepth(['workflow:root', 'agent:a', 'workflow:child'])).toBe(1)
		expect(
			deriveWorkflowDepth([
				'workflow:root',
				'agent:a',
				'workflow:child',
				'agent:b',
				'workflow:leaf',
			]),
		).toBe(2)
	})
})

describe('summarizeWorkflow — WorkflowResult → the plain handler summary', () => {
	it('summarizes a run as the terminal status + the result count', () => {
		const workflowContext = buildWorkflowContext({ id: 'wf-1', name: 'WF' })
		const phaseContext = buildPhaseContext(workflowContext, { id: 'p', name: 'P' })
		const statuses: readonly LifecycleStatus[] = ['completed', 'failed']
		const results: readonly TaskResult[] = statuses.map((status, index) => ({
			task: buildTaskContext(phaseContext, { id: `t${index}`, name: `t${index}` }),
			phase: phaseContext,
			workflow: workflowContext,
			status,
			timestamp: 0,
		}))
		const result: WorkflowResult = {
			workflow: createWorkflow({ id: 'wf-1', name: 'WF', phases: [] }),
			status: 'completed',
			results,
			durable: true,
			fault: {
				checkpoint: 'settlement',
				message: 'temporary refusal',
			},
		}
		expect(summarizeWorkflow(result)).toEqual({
			status: 'completed',
			count: 2,
			durable: true,
			fault: {
				checkpoint: 'settlement',
				message: 'temporary refusal',
			},
		})
	})

	it('an empty result list summarizes to count 0', () => {
		const result: WorkflowResult = {
			workflow: createWorkflow({ id: 'wf-2', name: 'WF2', phases: [] }),
			status: 'completed',
			results: [],
		}
		expect(summarizeWorkflow(result)).toEqual({ status: 'completed', count: 0 })
	})
})

describe('completeDraft — synthesize omitted ids/names into a strict definition', () => {
	it('fills EVERY missing id positionally + defaults each name to its (resolved) id', () => {
		const draft: WorkflowDraft = {
			phases: [{ tasks: [{ behavior: 'a' }, { behavior: 'b' }] }, { tasks: [{ behavior: 'c' }] }],
		}
		const definition = completeDraft(draft)
		expect(createWorkflowContract().is(definition)).toBe(true)
		expect(definition.id).toBe('wf')
		expect(definition.name).toBe('wf')
		expect(definition.phases.map((phase) => phase.id)).toEqual(['phase-0', 'phase-1'])
		expect(definition.phases[0]?.name).toBe('phase-0')
		expect(definition.phases[0]?.tasks.map((task) => task.id)).toEqual([
			'phase-0-task-0',
			'phase-0-task-1',
		])
		expect(definition.phases[0]?.tasks[0]?.name).toBe('phase-0-task-0')
		expect(definition.phases[1]?.tasks[0]?.id).toBe('phase-1-task-0')
		expect(definition.phases[0]?.tasks[0]?.behavior).toBe('a')
		expect(definition.phases[1]?.tasks[0]?.behavior).toBe('c')
	})

	it('PRESERVES a provided id/name verbatim and nests synthesized task ids under a provided phase id', () => {
		const definition = completeDraft({
			id: 'mine',
			phases: [{ id: 'p', name: 'Phase', tasks: [{ name: 'T', behavior: 'f' }] }],
		})
		expect(definition.id).toBe('mine')
		expect(definition.name).toBe('mine')
		expect(definition.phases[0]?.id).toBe('p')
		expect(definition.phases[0]?.name).toBe('Phase')
		expect(definition.phases[0]?.tasks[0]?.id).toBe('p-task-0')
		expect(definition.phases[0]?.tasks[0]?.name).toBe('T')
	})

	it('carries over description / concurrency / bail / retries / timeout unchanged', () => {
		const definition = completeDraft({
			description: 'desc',
			bail: true,
			phases: [
				{
					description: 'pd',
					concurrency: 3,
					bail: false,
					tasks: [{ behavior: 'x', retries: 2, timeout: 500, description: 'leaf' }],
				},
			],
		})
		expect(definition.description).toBe('desc')
		expect(definition.bail).toBe(true)
		expect(definition.phases[0]?.description).toBe('pd')
		expect(definition.phases[0]?.concurrency).toBe(3)
		expect(definition.phases[0]?.bail).toBe(false)
		expect(definition.phases[0]?.tasks[0]?.retries).toBe(2)
		expect(definition.phases[0]?.tasks[0]?.timeout).toBe(500)
		expect(definition.phases[0]?.tasks[0]?.description).toBe('leaf')
	})

	it('omits behavior/retries/timeout when the draft task declares none (no undefined keys)', () => {
		const definition = completeDraft({ phases: [{ tasks: [{}] }] })
		const task = definition.phases[0]?.tasks[0]
		expect(task && 'behavior' in task).toBe(false)
		expect(task && 'retries' in task).toBe(false)
		expect(task && 'timeout' in task).toBe(false)
	})

	it('is deterministic — the same draft always yields the same definition', () => {
		const draft: WorkflowDraft = { phases: [{ tasks: [{ behavior: 'x' }] }] }
		expect(completeDraft(draft)).toEqual(completeDraft(draft))
	})

	it('an empty-phases draft completes to a valid definition with no phases', () => {
		const definition = completeDraft({ phases: [] })
		expect(createWorkflowContract().is(definition)).toBe(true)
		expect(definition.phases).toEqual([])
	})

	it('completePhaseDraft / completeTaskDraft synthesize at their own positional index', () => {
		expect(completePhaseDraft({ tasks: [] }, 2).id).toBe('phase-2')
		expect(completeTaskDraft({ behavior: 't' }, 'phase-2', 5).id).toBe('phase-2-task-5')
	})

	it('completePhaseDraft preserves a provided phase id/name and its concurrency/bail', () => {
		const phase = completePhaseDraft(
			{ id: 'custom', name: 'Custom', tasks: [], concurrency: 4, bail: true },
			0,
		)
		expect(phase.id).toBe('custom')
		expect(phase.name).toBe('Custom')
		expect(phase.concurrency).toBe(4)
		expect(phase.bail).toBe(true)
	})

	it('completeTaskDraft preserves a provided task id/name', () => {
		const task = completeTaskDraft({ id: 'fixed', name: 'Fixed', behavior: 'f' }, 'phase-0', 0)
		expect(task.id).toBe('fixed')
		expect(task.name).toBe('Fixed')
	})
})

describe('expandSteps — flatten a steps blob into a one-task-phase-per-step definition', () => {
	it('maps each step to a one-task phase IN ORDER (a step`s name becomes the task`s behavior)', () => {
		const flat: WorkflowSteps = {
			name: 'pipeline',
			steps: [{ name: 'fetch' }, { name: 'scan' }, { name: 'audit' }],
		}
		const definition = expandSteps(flat)
		expect(createWorkflowContract().is(definition)).toBe(true)
		expect(definition.id).toBe('pipeline')
		expect(definition.name).toBe('pipeline')
		expect(definition.phases).toHaveLength(3)
		expect(definition.phases.map((phase) => phase.tasks.length)).toEqual([1, 1, 1])
		expect(definition.phases.map((phase) => phase.id)).toEqual(['phase-0', 'phase-1', 'phase-2'])
		expect(definition.phases[0]?.tasks[0]?.id).toBe('phase-0-task-0')
		expect(definition.phases[0]?.tasks[0]?.behavior).toBe('fetch')
		expect(definition.phases[1]?.tasks[0]?.behavior).toBe('scan')
		expect(definition.phases[2]?.tasks[0]?.behavior).toBe('audit')
	})

	it('defaults the workflow id (and name) when no name is supplied', () => {
		const definition = expandSteps({ steps: [{ name: 'only' }] })
		expect(definition.id).toBe('wf')
		expect(definition.name).toBe('wf')
	})

	it('an empty steps list expands to a valid, phase-less definition', () => {
		const definition: WorkflowDefinition = expandSteps({ steps: [] })
		expect(createWorkflowContract().is(definition)).toBe(true)
		expect(definition.phases).toEqual([])
	})
})

describe('inferTerminalCode — classify a caught error into a ToolboxErrorCode', () => {
	it('maps DEADLOCK and EXPIRE to their own code', () => {
		expect(inferTerminalCode(new TerminalError('DEADLOCK', 'cycle'))).toBe('DEADLOCK')
		expect(inferTerminalCode(new TerminalError('EXPIRE', 'timed out'))).toBe('EXPIRE')
	})

	it('maps every other TerminalErrorCode to the generic TOOL code', () => {
		expect(inferTerminalCode(new TerminalError('TARGET', 'unknown terminal'))).toBe('TOOL')
		expect(inferTerminalCode(new TerminalError('CANCEL', 'aborted'))).toBe('TOOL')
		expect(inferTerminalCode(new TerminalError('DRIVER', 'io failure'))).toBe('TOOL')
	})

	it('returns undefined for a non-TerminalError value', () => {
		expect(inferTerminalCode(new Error('plain'))).toBeUndefined()
		expect(inferTerminalCode('nope')).toBeUndefined()
		expect(inferTerminalCode(undefined)).toBeUndefined()
	})
})

describe('inferDatabaseCode / inferRelationCode — classify a caught error into its granular code', () => {
	it('inferDatabaseCode maps a real DatabaseError to its code', () => {
		expect(inferDatabaseCode(new DatabaseError('NOT_FOUND', 'missing row'))).toBe('NOT_FOUND')
		expect(inferDatabaseCode(new DatabaseError('CONFLICT', 'dup'))).toBe('CONFLICT')
	})

	it('inferDatabaseCode returns undefined for a non-DatabaseError value', () => {
		expect(inferDatabaseCode(new Error('plain'))).toBeUndefined()
		expect(inferDatabaseCode(undefined)).toBeUndefined()
		expect(inferDatabaseCode('nope')).toBeUndefined()
	})

	it('inferRelationCode maps a real RelationError to its code', () => {
		expect(inferRelationCode(new RelationError('INVALID', 'bad include'))).toBe('INVALID')
		expect(inferRelationCode(new RelationError('UNKNOWN_RELATION', 'missing'))).toBe(
			'UNKNOWN_RELATION',
		)
	})

	it('inferRelationCode returns undefined for a non-RelationError value', () => {
		expect(inferRelationCode(new Error('plain'))).toBeUndefined()
		expect(inferRelationCode(undefined)).toBeUndefined()
		expect(inferRelationCode('nope')).toBeUndefined()
	})
})

describe('resolveLimit — pick the effective row limit from a request and a cap', () => {
	it('an omitted request resolves to the cap', () => {
		expect(resolveLimit(undefined, 100)).toBe(100)
	})

	it('a request below the cap is honored', () => {
		expect(resolveLimit(10, 100)).toBe(10)
	})

	it('a request above the cap is clamped down to the cap', () => {
		expect(resolveLimit(500, 100)).toBe(100)
	})

	it('a negative request floors at 0', () => {
		expect(resolveLimit(-1, 100)).toBe(0)
	})

	it('a negative cap floors at 0', () => {
		expect(resolveLimit(undefined, -1)).toBe(0)
		expect(resolveLimit(10, -1)).toBe(0)
	})
})

describe('clampQuery — clamp a records call to a row cap + build the probe query', () => {
	it('an undefined query caps at the given cap with a probe of cap+1', () => {
		const { query, limit } = clampQuery(undefined, 100)
		expect(limit).toBe(100)
		expect(query.limit).toBe(101)
	})

	it('a requested limit below the cap is honored (probe = requested+1)', () => {
		const { query, limit } = clampQuery({ limit: 10 }, 100)
		expect(limit).toBe(10)
		expect(query.limit).toBe(11)
	})

	it('a requested limit above the cap is clamped down to the cap', () => {
		const { query, limit } = clampQuery({ limit: 500 }, 100)
		expect(limit).toBe(100)
		expect(query.limit).toBe(101)
	})

	it('a limit of 0 floors at 0 (probe requests exactly 1 row)', () => {
		const { query, limit } = clampQuery({ limit: 0 }, 100)
		expect(limit).toBe(0)
		expect(query.limit).toBe(1)
	})

	it('preserves conditions / order / offset unchanged', () => {
		const input: QueryInput = {
			conditions: [{ column: 'x', operator: 'equals', values: [1], connector: 'and' }],
			order: [{ column: 'x', direction: 'ascending' }],
			offset: 5,
			limit: 10,
		}
		const { query } = clampQuery(input, 100)
		expect(query.conditions).toEqual(input.conditions)
		expect(query.order).toEqual(input.order)
		expect(query.offset).toBe(5)
	})
})

describe('normalizeQuery — normalize a parsed wire query into a live QueryInput', () => {
	it('returns undefined when the input is undefined', () => {
		expect(normalizeQuery(undefined)).toBeUndefined()
	})

	it('defaults an omitted condition connector to "and", preserving an explicit one', () => {
		const result = normalizeQuery({
			conditions: [
				{ column: 'a', operator: 'equals', values: [1] },
				{ column: 'b', operator: 'equals', values: [2], connector: 'or' },
			],
		})
		expect(result?.conditions).toEqual([
			{ column: 'a', operator: 'equals', values: [1], connector: 'and' },
			{ column: 'b', operator: 'equals', values: [2], connector: 'or' },
		])
	})

	it('passes order / limit / offset through unchanged, omitting fields not supplied', () => {
		const result = normalizeQuery({
			order: [{ column: 'a', direction: 'descending' }],
			limit: 5,
			offset: 2,
		})
		expect(result).toEqual({
			order: [{ column: 'a', direction: 'descending' }],
			limit: 5,
			offset: 2,
		})
		expect('conditions' in (result ?? {})).toBe(false)
	})

	it('an empty query object yields an empty (no-key) result', () => {
		expect(normalizeQuery({})).toEqual({})
	})
})

describe('expandInclude — expand a flat dot-path include list into a nested Include tree', () => {
	it('a single-segment path becomes a bare true leaf', () => {
		expect(expandInclude(['contacts'], 3)).toEqual({ contacts: true })
	})

	it('a multi-segment path nests', () => {
		expect(expandInclude(['contacts.account'], 3)).toEqual({ contacts: { account: true } })
		expect(expandInclude(['a.b.c'], 3)).toEqual({ a: { b: { c: true } } })
	})

	it('sibling paths merge under a shared prefix', () => {
		expect(expandInclude(['contacts.account', 'contacts.notes'], 3)).toEqual({
			contacts: { account: true, notes: true },
		})
	})

	it("a longer path SUBSUMES a shorter sibling's bare true, never overwriting the deeper chain", () => {
		expect(expandInclude(['contacts', 'contacts.account'], 3)).toEqual({
			contacts: { account: true },
		})
		expect(expandInclude(['contacts.account', 'contacts'], 3)).toEqual({
			contacts: { account: true },
		})
	})

	it('a path exceeding the depth cap throws a typed TOOL ToolboxError', () => {
		expect(() => expandInclude(['a.b.c'], 2)).toThrow(ToolboxError)
		let caught: unknown
		try {
			expandInclude(['a.b.c'], 2)
		} catch (error) {
			caught = error
		}
		expect(isToolboxError(caught) ? caught.code : undefined).toBe('TOOL')
	})

	it('an empty segment (leading/trailing/doubled dot) throws a typed TOOL ToolboxError', () => {
		expect(() => expandInclude(['.a'], 3)).toThrow(ToolboxError)
		expect(() => expandInclude(['a..b'], 3)).toThrow(ToolboxError)
		expect(() => expandInclude(['a.'], 3)).toThrow(ToolboxError)
	})

	it('an undefined paths list yields the empty Include', () => {
		expect(expandInclude(undefined, 3)).toEqual({})
	})

	it('an empty array yields the empty Include', () => {
		expect(expandInclude([], 3)).toEqual({})
	})
})
