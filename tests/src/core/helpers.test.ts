import type { QueryInput } from '@orkestrel/database'
import type { WorkflowDraft, WorkflowSteps } from '@src/core'
import type {
	TaskResult,
	TaskStatus,
	WorkflowDefinition,
	WorkflowResult,
} from '@orkestrel/workflow'
import {
	agentTag,
	ToolboxError,
	clampQuery,
	completeDraft,
	completePhaseDraft,
	completeTaskDraft,
	createAgentFunction,
	deriveWorkflowDepth,
	extendLineage,
	lineageOf,
	queryOf,
	databaseToolCode,
	expandInclude,
	expandSteps,
	expandTables,
	isAgentFunction,
	isToolboxError,
	isColumnKind,
	isColumnSpec,
	isDatabaseDefinition,
	isWorkflowLineage,
	relationToolCode,
	terminalToolCode,
	workflowTag,
	workflowToolSummary,
} from '@src/core'
import { createAgent } from '@orkestrel/agent'
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
import { createContract, objectShape } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'
import { ScriptedProvider } from '../../setup.js'

// tests/src/core/helpers.test.ts — mirrors src/core/helpers.ts. Pure, deterministic
// synthesis (AGENTS §16.1: real inputs, no mocks): the ancestry tag namespacing, the
// workflow-tool run summary, and the draft-completion / flat-steps-expansion pipeline
// that turns the tool's LENIENT authoring surfaces into a strict WorkflowDefinition
// (`@orkestrel/workflow`).

describe('ancestry tags — workflowTag / agentTag (depth/cycle chain identifiers)', () => {
	it('namespaces a workflow id and an agent name distinctly (no collision)', () => {
		expect(workflowTag('x')).toBe('workflow:x')
		expect(agentTag('x')).toBe('agent:x')
		expect(workflowTag('x')).not.toBe(agentTag('x'))
	})

	it('is a pure function of its input id/name', () => {
		expect(workflowTag('release')).toBe('workflow:release')
		expect(agentTag('reviewer')).toBe('agent:reviewer')
	})
})

describe('workflow lineage helpers', () => {
	it('validates strict alternating unique nonempty tags beginning with workflow', () => {
		expect(isWorkflowLineage([])).toBe(true)
		expect(isWorkflowLineage(['workflow:root', 'agent:a', 'workflow:child'])).toBe(true)
		for (const invalid of [
			['agent:a'],
			['workflow:'],
			['workflow:a', 'workflow:b'],
			['workflow:a', 'agent:b', 'workflow:a'],
			['workflow:a', 'agent:b', 'agent:c'],
		]) {
			expect(isWorkflowLineage(invalid)).toBe(false)
		}
		const revoked = Proxy.revocable<readonly string[]>(['workflow:root'], {})
		revoked.revoke()
		expect(isWorkflowLineage(revoked.proxy)).toBe(false)
	})

	it('copies and freezes construction and extension without aliasing caller arrays', () => {
		const source = ['workflow:root']
		const root = lineageOf(source)
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
				lineageOf(lineage)
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

	it('recognizes only frozen agent adapters carrying frozen valid metadata', () => {
		const fn = createAgentFunction(createAgent(new ScriptedProvider([{ content: 'ok' }])))
		expect(isAgentFunction(fn)).toBe(true)
		expect(isAgentFunction(() => 'opaque')).toBe(false)
		expect(
			isAgentFunction(
				Object.freeze(
					Object.assign(() => 'spoof', {
						category: 'agent',
						lineage: ['agent:wrong'],
					}),
				),
			),
		).toBe(false)
		const revoked = Proxy.revocable(() => 'revoked', {})
		revoked.revoke()
		expect(isAgentFunction(revoked.proxy)).toBe(false)
	})
})

describe('workflowToolSummary — WorkflowResult → the plain handler summary', () => {
	it('summarizes a run as the terminal status + the result count', () => {
		const workflowContext = buildWorkflowContext({ id: 'wf-1', name: 'WF' })
		const phaseContext = buildPhaseContext(workflowContext, { id: 'p', name: 'P' })
		const statuses: readonly TaskStatus[] = ['completed', 'failed']
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
				origin: 'persistence',
				checkpoint: 'settlement',
				message: 'temporary refusal',
			},
		}
		expect(workflowToolSummary(result)).toEqual({
			status: 'completed',
			count: 2,
			durable: true,
			fault: {
				origin: 'persistence',
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
		expect(workflowToolSummary(result)).toEqual({ status: 'completed', count: 0 })
	})
})

describe('completeDraft — synthesize omitted ids/names into a strict definition', () => {
	it('fills EVERY missing id positionally + defaults each name to its (resolved) id', () => {
		const draft: WorkflowDraft = {
			phases: [{ tasks: [{ run: 'a' }, { run: 'b' }] }, { tasks: [{ run: 'c' }] }],
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
		expect(definition.phases[0]?.tasks[0]?.run).toBe('a')
		expect(definition.phases[1]?.tasks[0]?.run).toBe('c')
	})

	it('PRESERVES a provided id/name verbatim and nests synthesized task ids under a provided phase id', () => {
		const definition = completeDraft({
			id: 'mine',
			phases: [{ id: 'p', name: 'Phase', tasks: [{ name: 'T', run: 'f' }] }],
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
					tasks: [{ run: 'x', retries: 2, timeout: 500, description: 'leaf' }],
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

	it('omits run/retries/timeout when the draft task declares none (no undefined keys)', () => {
		const definition = completeDraft({ phases: [{ tasks: [{}] }] })
		const task = definition.phases[0]?.tasks[0]
		expect(task && 'run' in task).toBe(false)
		expect(task && 'retries' in task).toBe(false)
		expect(task && 'timeout' in task).toBe(false)
	})

	it('is deterministic — the same draft always yields the same definition', () => {
		const draft: WorkflowDraft = { phases: [{ tasks: [{ run: 'x' }] }] }
		expect(completeDraft(draft)).toEqual(completeDraft(draft))
	})

	it('an empty-phases draft completes to a valid definition with no phases', () => {
		const definition = completeDraft({ phases: [] })
		expect(createWorkflowContract().is(definition)).toBe(true)
		expect(definition.phases).toEqual([])
	})

	it('completePhaseDraft / completeTaskDraft synthesize at their own positional index', () => {
		expect(completePhaseDraft({ tasks: [] }, 2).id).toBe('phase-2')
		expect(completeTaskDraft({ run: 't' }, 'phase-2', 5).id).toBe('phase-2-task-5')
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
		const task = completeTaskDraft({ id: 'fixed', name: 'Fixed', run: 'f' }, 'phase-0', 0)
		expect(task.id).toBe('fixed')
		expect(task.name).toBe('Fixed')
	})
})

describe('expandSteps — flatten a steps blob into a one-task-phase-per-step definition', () => {
	it('maps each step to a one-task phase IN ORDER (a step`s name becomes the task`s run)', () => {
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
		expect(definition.phases[0]?.tasks[0]?.run).toBe('fetch')
		expect(definition.phases[1]?.tasks[0]?.run).toBe('scan')
		expect(definition.phases[2]?.tasks[0]?.run).toBe('audit')
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

describe('terminalToolCode — classify a caught error into a ToolboxErrorCode', () => {
	it('maps DEADLOCK and EXPIRE to their own code', () => {
		expect(terminalToolCode(new TerminalError('DEADLOCK', 'cycle'))).toBe('DEADLOCK')
		expect(terminalToolCode(new TerminalError('EXPIRE', 'timed out'))).toBe('EXPIRE')
	})

	it('maps every other TerminalErrorCode to the generic TOOL code', () => {
		expect(terminalToolCode(new TerminalError('TARGET', 'unknown terminal'))).toBe('TOOL')
		expect(terminalToolCode(new TerminalError('CANCEL', 'aborted'))).toBe('TOOL')
		expect(terminalToolCode(new TerminalError('DRIVER', 'io failure'))).toBe('TOOL')
	})

	it('returns undefined for a non-TerminalError value', () => {
		expect(terminalToolCode(new Error('plain'))).toBeUndefined()
		expect(terminalToolCode('nope')).toBeUndefined()
		expect(terminalToolCode(undefined)).toBeUndefined()
	})
})

describe('isColumnKind — narrow to a valid ColumnKind literal', () => {
	it('accepts every ColumnKind', () => {
		expect(isColumnKind('string')).toBe(true)
		expect(isColumnKind('integer')).toBe(true)
		expect(isColumnKind('number')).toBe(true)
		expect(isColumnKind('boolean')).toBe(true)
	})

	it('rejects a non-ColumnKind string and a non-string value', () => {
		expect(isColumnKind('text')).toBe(false)
		expect(isColumnKind('')).toBe(false)
		expect(isColumnKind(42)).toBe(false)
		expect(isColumnKind(undefined)).toBe(false)
		expect(isColumnKind(null)).toBe(false)
		expect(isColumnKind({})).toBe(false)
	})
})

describe('isColumnSpec — narrow to a bare ColumnKind or an { type, optional } object', () => {
	it('accepts a bare ColumnKind shorthand', () => {
		expect(isColumnSpec('string')).toBe(true)
		expect(isColumnSpec('integer')).toBe(true)
		expect(isColumnSpec('number')).toBe(true)
		expect(isColumnSpec('boolean')).toBe(true)
	})

	it('accepts the object form with a valid type, with and without optional', () => {
		expect(isColumnSpec({ type: 'string' })).toBe(true)
		expect(isColumnSpec({ type: 'integer', optional: true })).toBe(true)
		expect(isColumnSpec({ type: 'boolean', optional: false })).toBe(true)
	})

	it('rejects an invalid type, a wrong-typed optional, and junk values', () => {
		expect(isColumnSpec({ type: 'text' })).toBe(false)
		expect(isColumnSpec({ type: 'string', optional: 'yes' })).toBe(false)
		expect(isColumnSpec({})).toBe(false)
		expect(isColumnSpec(null)).toBe(false)
		expect(isColumnSpec(42)).toBe(false)
		expect(isColumnSpec('text')).toBe(false)
		expect(isColumnSpec([])).toBe(false)
	})
})

describe('expandTables — compile a TableSpec into a @orkestrel/database TableMap', () => {
	it('maps each ColumnKind to the matching primitive shaper (guards good/bad values)', () => {
		const tables = expandTables({
			widgets: {
				columns: { name: 'string', count: 'integer', weight: 'number', active: 'boolean' },
			},
		})
		const widgets = tables.widgets
		if (widgets === undefined) throw new Error('expected widgets table')
		const contract = createContract(objectShape(widgets))
		expect(contract.is({ name: 'w', count: 1, weight: 1.5, active: true })).toBe(true)
		expect(contract.is({ name: 42, count: 1, weight: 1.5, active: true })).toBe(false)
		expect(contract.is({ name: 'w', count: 1.5, weight: 1.5, active: true })).toBe(false)
		expect(contract.is({ name: 'w', count: 1, weight: 'x', active: true })).toBe(false)
		expect(contract.is({ name: 'w', count: 1, weight: 1.5, active: 'yes' })).toBe(false)
	})

	it('optional:true wraps so an absent column passes and a wrong-typed present column fails', () => {
		const tables = expandTables({
			widgets: { columns: { nickname: { type: 'string', optional: true } } },
		})
		const widgets = tables.widgets
		if (widgets === undefined) throw new Error('expected widgets table')
		const contract = createContract(objectShape(widgets))
		expect(contract.is({})).toBe(true)
		expect(contract.is({ nickname: 'w' })).toBe(true)
		expect(contract.is({ nickname: 42 })).toBe(false)
	})

	it('compiles multiple tables independently', () => {
		const tables = expandTables({
			a: { columns: { x: 'string' } },
			b: { columns: { y: 'integer' } },
		})
		expect(Object.keys(tables).sort()).toEqual(['a', 'b'])
		const a = tables.a
		const b = tables.b
		if (a === undefined || b === undefined) throw new Error('expected both tables')
		expect(createContract(objectShape(a)).is({ x: 's' })).toBe(true)
		expect(createContract(objectShape(b)).is({ y: 1 })).toBe(true)
	})
})

describe('isDatabaseDefinition — narrow an untrusted value to a DatabaseDefinition', () => {
	const valid = {
		id: 'db-1',
		driver: 'memory',
		tables: { widgets: { columns: { name: 'string', qty: { type: 'integer', optional: true } } } },
		primary: { widgets: 'name' },
		indexes: { widgets: [['name'], ['name', 'qty']] },
		version: 2.5,
	}

	it('accepts a full valid definition, with and without optional schema configuration', () => {
		expect(isDatabaseDefinition(valid)).toBe(true)
		const {
			primary: _primary,
			indexes: _indexes,
			version: _version,
			...withoutConfiguration
		} = valid
		expect(isDatabaseDefinition(withoutConfiguration)).toBe(true)
	})

	it('rejects a missing or empty id / driver', () => {
		const { id: _id, ...withoutId } = valid
		expect(isDatabaseDefinition(withoutId)).toBe(false)
		expect(isDatabaseDefinition({ ...valid, id: '' })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, driver: '' })).toBe(false)
	})

	it('rejects malformed tables / columns', () => {
		expect(isDatabaseDefinition({ ...valid, tables: 'nope' })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, tables: { widgets: 'nope' } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, tables: { widgets: { columns: 'nope' } } })).toBe(false)
		expect(
			isDatabaseDefinition({ ...valid, tables: { widgets: { columns: { name: 'text' } } } }),
		).toBe(false)
	})

	it('rejects wrong-typed primary values and the obsolete keys field', () => {
		expect(isDatabaseDefinition({ ...valid, primary: 'nope' })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, primary: { widgets: 42 } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, primary: { widgets: '' } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, primary: undefined, keys: { widgets: 'name' } })).toBe(
			false,
		)
	})

	it('accepts empty index lists and rejects malformed groups or nonfinite versions', () => {
		expect(isDatabaseDefinition({ ...valid, indexes: { widgets: [] } })).toBe(true)
		expect(isDatabaseDefinition({ ...valid, indexes: { widgets: [[]] } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, indexes: { widgets: [['']] } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, indexes: { widgets: 'name' } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, version: Number.NaN })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, version: Number.NEGATIVE_INFINITY })).toBe(false)
	})

	it('rejects non-objects', () => {
		expect(isDatabaseDefinition(null)).toBe(false)
		expect(isDatabaseDefinition(undefined)).toBe(false)
		expect(isDatabaseDefinition('nope')).toBe(false)
		expect(isDatabaseDefinition(42)).toBe(false)
		expect(isDatabaseDefinition([])).toBe(false)
	})
})

describe('databaseToolCode / relationToolCode — classify a caught error into its granular code', () => {
	it('databaseToolCode maps a real DatabaseError to its code', () => {
		expect(databaseToolCode(new DatabaseError('NOT_FOUND', 'missing row'))).toBe('NOT_FOUND')
		expect(databaseToolCode(new DatabaseError('CONFLICT', 'dup'))).toBe('CONFLICT')
	})

	it('databaseToolCode returns undefined for a non-DatabaseError value', () => {
		expect(databaseToolCode(new Error('plain'))).toBeUndefined()
		expect(databaseToolCode(undefined)).toBeUndefined()
		expect(databaseToolCode('nope')).toBeUndefined()
	})

	it('relationToolCode maps a real RelationError to its code', () => {
		expect(relationToolCode(new RelationError('INVALID', 'bad include'))).toBe('INVALID')
		expect(relationToolCode(new RelationError('UNKNOWN_RELATION', 'missing'))).toBe(
			'UNKNOWN_RELATION',
		)
	})

	it('relationToolCode returns undefined for a non-RelationError value', () => {
		expect(relationToolCode(new Error('plain'))).toBeUndefined()
		expect(relationToolCode(undefined)).toBeUndefined()
		expect(relationToolCode('nope')).toBeUndefined()
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

describe('queryOf — normalize a parsed wire query into a live QueryInput', () => {
	it('returns undefined when the input is undefined', () => {
		expect(queryOf(undefined)).toBeUndefined()
	})

	it('defaults an omitted condition connector to "and", preserving an explicit one', () => {
		const result = queryOf({
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
		const result = queryOf({
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
		expect(queryOf({})).toEqual({})
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
