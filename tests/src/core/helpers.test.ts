import type { Criteria, TableSchema } from '@orkestrel/database'
import type { WorkflowDraft, WorkflowSteps } from '@src/core'
import type {
	TaskResult,
	TaskStatus,
	WorkflowDefinition,
	WorkflowResult,
} from '@orkestrel/workflow'
import type { PromptType } from '@orkestrel/terminal'
import {
	agentTag,
	AgentToolError,
	clampCriteria,
	coerceAnswer,
	columnSchema,
	completeDraft,
	completePhaseDraft,
	completeTaskDraft,
	criteriaOf,
	databaseToolCode,
	expandInclude,
	expandSteps,
	expandTables,
	isAgentToolError,
	isColumnKind,
	isColumnSpec,
	isDatabaseDefinition,
	relationToolCode,
	tableSchema,
	terminalToolCode,
	workflowTag,
	workflowToolSummary,
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
import { createContract, integerShape, objectShape, stringShape } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'

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

describe('workflowToolSummary — WorkflowResult → the plain handler summary', () => {
	it('summarizes a run as the terminal status + the result count', () => {
		const workflowContext = buildWorkflowContext({ id: 'wf-1', name: 'WF' })
		const phaseContext = buildPhaseContext(workflowContext, { id: 'p', name: 'P' })
		const taskResult = (id: string, status: TaskStatus): TaskResult => ({
			task: buildTaskContext(phaseContext, { id, name: id }),
			phase: phaseContext,
			workflow: workflowContext,
			status,
			timestamp: 0,
		})
		const result: WorkflowResult = {
			workflow: createWorkflow({ id: 'wf-1', name: 'WF', phases: [] }),
			status: 'completed',
			results: [taskResult('t0', 'completed'), taskResult('t1', 'failed')],
		}
		expect(workflowToolSummary(result)).toEqual({ status: 'completed', count: 2 })
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

describe('coerceAnswer — normalize an LLM-supplied answer to its prompt form', () => {
	it('confirm: passes a boolean through and coerces "true"/"false" strings', () => {
		expect(coerceAnswer('confirm', true)).toBe(true)
		expect(coerceAnswer('confirm', false)).toBe(false)
		expect(coerceAnswer('confirm', 'true')).toBe(true)
		expect(coerceAnswer('confirm', 'False')).toBe(false)
		expect(coerceAnswer('confirm', 'yes')).toBe(true)
		expect(coerceAnswer('confirm', '')).toBe(false)
	})

	it('checkbox: passes an array through, splits a comma-separated string, wraps a single string', () => {
		expect(coerceAnswer('checkbox', ['a', 'b'])).toEqual(['a', 'b'])
		expect(coerceAnswer('checkbox', 'a,b')).toEqual(['a', 'b'])
		expect(coerceAnswer('checkbox', 'a, b , c')).toEqual(['a', 'b', 'c'])
		expect(coerceAnswer('checkbox', 'solo')).toEqual(['solo'])
	})

	it('input/password/select/editor: passes a string through, stringifies a scalar, blanks an object', () => {
		expect(coerceAnswer('input', 'hi')).toBe('hi')
		expect(coerceAnswer('password', 'hi')).toBe('hi')
		expect(coerceAnswer('select', 'hi')).toBe('hi')
		expect(coerceAnswer('editor', 'hi')).toBe('hi')
		expect(coerceAnswer('input', 42)).toBe('42')
		expect(coerceAnswer('input', { a: 1 })).toBe('')
		expect(coerceAnswer('input', ['a'])).toBe('')
	})

	it('is deterministic — same form/value always yields the same result', () => {
		expect(coerceAnswer('checkbox', 'x,y')).toEqual(coerceAnswer('checkbox', 'x,y'))
	})
})

describe('pressure: coerceAnswer — hostile-value fuzz (totality, exact branch pinning)', () => {
	it('confirm: boolean passthrough — only literal true/false pass through unchanged', () => {
		expect(coerceAnswer('confirm', true)).toBe(true)
		expect(coerceAnswer('confirm', false)).toBe(false)
	})

	it('confirm: "TRUE" / " true " / "True" all case/whitespace-insensitively coerce true', () => {
		expect(coerceAnswer('confirm', 'TRUE')).toBe(true)
		expect(coerceAnswer('confirm', ' true ')).toBe(true)
		expect(coerceAnswer('confirm', 'True')).toBe(true)
	})

	it('confirm: 0 is NOT the string "false" — it falls through to Boolean(value), which is false', () => {
		expect(coerceAnswer('confirm', 0)).toBe(false)
	})

	it('confirm: a non-empty object/array is truthy-coerced via Boolean(value) (never "" special-cased)', () => {
		expect(coerceAnswer('confirm', {})).toBe(true)
		expect(coerceAnswer('confirm', [])).toBe(true)
	})

	it('checkbox: a comma-separated string with surrounding spaces trims every entry', () => {
		expect(coerceAnswer('checkbox', 'a, b , c')).toEqual(['a', 'b', 'c'])
	})

	it('checkbox: a single non-comma string wraps into a one-item array', () => {
		expect(coerceAnswer('checkbox', 'a')).toEqual(['a'])
	})

	it('checkbox: an array of strings passes through, stringifying each entry', () => {
		expect(coerceAnswer('checkbox', ['a', 'b'])).toEqual(['a', 'b'])
	})

	it('checkbox: a NESTED array entry stringifies to its Array.prototype.toString form ("a")', () => {
		expect(coerceAnswer('checkbox', [['a']])).toEqual(['a'])
	})

	it('checkbox: a bare number is NOT an array/string — falls to the [String(value)] fallback', () => {
		expect(coerceAnswer('checkbox', 5)).toEqual(['5'])
	})

	it('checkbox: a bare object is NOT an array/string — falls to the [String(value)] fallback ("[object Object]")', () => {
		expect(coerceAnswer('checkbox', {})).toEqual(['[object Object]'])
	})

	it('text forms (input/password/select/editor): a number scalar stringifies via String(value)', () => {
		expect(coerceAnswer('input', 42)).toBe('42')
		expect(coerceAnswer('password', 42)).toBe('42')
		expect(coerceAnswer('select', 42)).toBe('42')
		expect(coerceAnswer('editor', 42)).toBe('42')
	})

	it('text forms: a boolean scalar stringifies via String(value)', () => {
		expect(coerceAnswer('input', true)).toBe('true')
	})

	it('text forms: an object/array falls back to "" rather than serializing garbage', () => {
		expect(coerceAnswer('input', {})).toBe('')
		expect(coerceAnswer('input', [])).toBe('')
	})

	it('text forms: an empty string passes through verbatim (not stringified/blanked)', () => {
		expect(coerceAnswer('input', '')).toBe('')
	})

	it('is total — never throws for any hostile value across every form', () => {
		const hostileValues: readonly unknown[] = [
			'TRUE',
			' true ',
			'True',
			true,
			0,
			{},
			[],
			'a, b , c',
			'a',
			['a', 'b'],
			[['a']],
			42,
			'',
			null,
			undefined,
			NaN,
		]
		const forms: readonly PromptType[] = [
			'confirm',
			'checkbox',
			'input',
			'password',
			'select',
			'editor',
		]
		for (const form of forms) {
			for (const value of hostileValues) {
				expect(() => coerceAnswer(form, value)).not.toThrow()
			}
		}
	})
})

describe('terminalToolCode — classify a caught error into an AgentToolErrorCode', () => {
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

describe('expandTables — compile a TableSpec into a @orkestrel/database TablesShape', () => {
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
		keys: { widgets: 'name' },
	}

	it('accepts a full valid definition, with and without keys', () => {
		expect(isDatabaseDefinition(valid)).toBe(true)
		const { keys: _keys, ...withoutKeys } = valid
		expect(isDatabaseDefinition(withoutKeys)).toBe(true)
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

	it('rejects wrong-typed keys values', () => {
		expect(isDatabaseDefinition({ ...valid, keys: 'nope' })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, keys: { widgets: 42 } })).toBe(false)
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

describe('clampCriteria — clamp a records call to a row cap + build the probe criteria', () => {
	it('an undefined criteria caps at the given cap with a probe of cap+1', () => {
		const { criteria, limit } = clampCriteria(undefined, 100)
		expect(limit).toBe(100)
		expect(criteria.limit).toBe(101)
	})

	it('a requested limit below the cap is honored (probe = requested+1)', () => {
		const { criteria, limit } = clampCriteria({ limit: 10 }, 100)
		expect(limit).toBe(10)
		expect(criteria.limit).toBe(11)
	})

	it('a requested limit above the cap is clamped down to the cap', () => {
		const { criteria, limit } = clampCriteria({ limit: 500 }, 100)
		expect(limit).toBe(100)
		expect(criteria.limit).toBe(101)
	})

	it('a limit of 0 floors at 0 (probe requests exactly 1 row)', () => {
		const { criteria, limit } = clampCriteria({ limit: 0 }, 100)
		expect(limit).toBe(0)
		expect(criteria.limit).toBe(1)
	})

	it('preserves conditions / order / offset unchanged', () => {
		const input: Criteria = {
			conditions: [{ column: 'x', operator: 'equals', values: [1], connector: 'and' }],
			order: [{ column: 'x', direction: 'ascending' }],
			offset: 5,
			limit: 10,
		}
		const { criteria } = clampCriteria(input, 100)
		expect(criteria.conditions).toEqual(input.conditions)
		expect(criteria.order).toEqual(input.order)
		expect(criteria.offset).toBe(5)
	})
})

describe('criteriaOf — normalize parsed wire criteria into a live Criteria', () => {
	it('returns undefined when the input is undefined', () => {
		expect(criteriaOf(undefined)).toBeUndefined()
	})

	it('defaults an omitted condition connector to "and", preserving an explicit one', () => {
		const result = criteriaOf({
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
		const result = criteriaOf({
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

	it('an empty criteria object yields an empty (no-key) result', () => {
		expect(criteriaOf({})).toEqual({})
	})
})

describe('columnSchema — map a column name + ContractShape to a ColumnSchema', () => {
	it('projects the expected shape for a non-optional column', () => {
		expect(columnSchema('name', stringShape())).toEqual({
			name: 'name',
			type: 'text',
			nullable: false,
		})
	})

	it('projects the expected shape for an integer column', () => {
		expect(columnSchema('qty', integerShape())).toEqual({
			name: 'qty',
			type: 'integer',
			nullable: false,
		})
	})
})

describe('tableSchema — build a TableSchema from a table name + TableExport', () => {
	it('projects name/primary/columns/indexes from a live table handle', () => {
		const result: TableSchema = tableSchema('widgets', {
			key: 'id',
			columns: { id: stringShape(), qty: integerShape() },
		})
		expect(result).toEqual({
			name: 'widgets',
			primary: 'id',
			columns: [
				{ name: 'id', type: 'text', nullable: false },
				{ name: 'qty', type: 'integer', nullable: false },
			],
			indexes: [],
		})
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

	it('a path exceeding the depth cap throws a typed TOOL AgentToolError', () => {
		expect(() => expandInclude(['a.b.c'], 2)).toThrow(AgentToolError)
		let caught: unknown
		try {
			expandInclude(['a.b.c'], 2)
		} catch (error) {
			caught = error
		}
		expect(isAgentToolError(caught) ? caught.code : undefined).toBe('TOOL')
	})

	it('an empty segment (leading/trailing/doubled dot) throws a typed TOOL AgentToolError', () => {
		expect(() => expandInclude(['.a'], 3)).toThrow(AgentToolError)
		expect(() => expandInclude(['a..b'], 3)).toThrow(AgentToolError)
		expect(() => expandInclude(['a.'], 3)).toThrow(AgentToolError)
	})

	it('an undefined paths list yields the empty Include', () => {
		expect(expandInclude(undefined, 3)).toEqual({})
	})

	it('an empty array yields the empty Include', () => {
		expect(expandInclude([], 3)).toEqual({})
	})
})
