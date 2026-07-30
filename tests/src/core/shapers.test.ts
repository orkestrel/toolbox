import {
	agentToolShape,
	databaseToolShape,
	relationToolShape,
	workflowDraftShape,
	workflowStepsShape,
	workspaceToolShape,
} from '@src/core'
import type { AgentToolArguments, WorkspaceOperation } from '@src/core'
import { createContract, isRecord } from '@orkestrel/contract'
import type { Infer } from '@orkestrel/contract'
import { describe, expect, expectTypeOf, it } from 'vitest'

// tests/src/core/shapers.test.ts — mirrors src/core/shapers.ts. Each shape compiles
// (`createContract`, `@orkestrel/contract`) into a lockstep guard/parser/schema/generator
// (AGENTS §14); these tests pin the guard accept/reject behavior, the parser soundness, and
// the JSON Schema shape each `create*Tool` factory advertises.

describe('agentToolShape — createAgentTool call args', () => {
	const contract = createContract(agentToolShape)

	it('Infer<typeof agentToolShape> stays structurally locked to the hand-written AgentToolArguments (types.ts) — a compile-time guard against silent two-copy drift (AGENTS §5)', () => {
		expectTypeOf<Infer<typeof agentToolShape>>().toEqualTypeOf<AgentToolArguments>()
	})

	it('is() accepts a task-only call and a call with every optional field', () => {
		expect(contract.is({ task: 'do the thing' })).toBe(true)
		expect(
			contract.is({
				task: 'do the thing',
				provider: 'openai',
				tools: ['search'],
				system: 'be terse',
			}),
		).toBe(true)
	})

	it('is() rejects a missing or empty task', () => {
		expect(contract.is({})).toBe(false)
		expect(contract.is({ task: '' })).toBe(false)
	})

	it('is() rejects a wrong-typed optional field', () => {
		expect(contract.is({ task: 'x', provider: 42 })).toBe(false)
		expect(contract.is({ task: 'x', tools: 'not-an-array' })).toBe(false)
		expect(contract.is({ task: 'x', tools: [''] })).toBe(false)
		expect(contract.is({ task: 'x', system: 42 })).toBe(false)
	})

	it('parse() returns the value unchanged for a valid call, undefined for an invalid one', () => {
		const call = { task: 'x', provider: 'p' }
		expect(contract.parse(call)).toEqual(call)
		expect(contract.parse({})).toBeUndefined()
	})

	it('generate() produces a value its own guard accepts (round-trip)', () => {
		const generated = contract.generate()
		expect(contract.is(generated)).toBe(true)
		expect(contract.parse(generated)).toEqual(generated)
	})

	it('the compiled JSON Schema requires task and marks it non-empty', () => {
		expect(contract.schema.type).toBe('object')
		const properties = contract.schema.properties
		expect(isRecord(properties) ? Object.keys(properties).sort() : []).toEqual([
			'provider',
			'system',
			'task',
			'tools',
		])
		expect(contract.schema.required).toEqual(['task'])
	})
})

describe('workflowDraftShape — the lenient draft (ids/names optional at every level)', () => {
	const contract = createContract(workflowDraftShape)

	it('is() accepts an ids-omitted draft', () => {
		expect(contract.is({ phases: [{ tasks: [{ run: 'a' }] }] })).toBe(true)
		expect(contract.is({ phases: [] })).toBe(true)
	})

	it('is() accepts a fully ids/names-provided draft', () => {
		expect(
			contract.is({
				id: 'w',
				name: 'W',
				phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: 'f' }] }],
			}),
		).toBe(true)
	})

	it('is() REJECTS an explicitly-empty id/name (present but blank, not omitted)', () => {
		expect(contract.is({ id: '', phases: [] })).toBe(false)
		expect(contract.is({ name: '', phases: [] })).toBe(false)
		expect(contract.parse({ id: '', phases: [] })).toBeUndefined()
	})

	it('is() rejects missing phases or a non-array phases', () => {
		expect(contract.is({})).toBe(false)
		expect(contract.is({ phases: 'nope' })).toBe(false)
	})

	it('is() rejects a task with an empty run, or a sub-1 concurrency', () => {
		expect(contract.is({ phases: [{ tasks: [{ run: '' }] }] })).toBe(false)
		expect(contract.is({ phases: [{ tasks: [], concurrency: 0 }] })).toBe(false)
	})

	it('generate() round-trips through its own guard and parser', () => {
		const generated = contract.generate()
		expect(contract.is(generated)).toBe(true)
		expect(contract.parse(generated)).toEqual(generated)
	})
})

describe('workflowStepsShape — the advertised flat authoring surface', () => {
	const contract = createContract(workflowStepsShape)

	it('is() accepts a minimal steps list and a named one', () => {
		expect(contract.is({ steps: [{ name: 'compile' }] })).toBe(true)
		expect(
			contract.is({ name: 'release', steps: [{ name: 'compile' }, { name: 'publish' }] }),
		).toBe(true)
	})

	it('is() accepts an empty steps array', () => {
		expect(contract.is({ steps: [] })).toBe(true)
	})

	it('is() rejects a missing steps array or a step missing name', () => {
		expect(contract.is({})).toBe(false)
		expect(contract.is({ steps: [{}] })).toBe(false)
		expect(contract.is({ steps: [{ name: '' }] })).toBe(false)
	})

	it('parse() returns undefined for malformed input', () => {
		expect(contract.parse({ steps: [{}] })).toBeUndefined()
	})

	it('the compiled JSON Schema exposes only name (optional) and steps', () => {
		const properties = contract.schema.properties
		expect(isRecord(properties) ? Object.keys(properties).sort() : []).toEqual(['name', 'steps'])
	})
})

describe('workspaceToolShape — the 13-op discriminated union', () => {
	const contract = createContract(workspaceToolShape)

	it('Infer<typeof workspaceToolShape> stays structurally locked to the hand-written WorkspaceOperation (types.ts) — a compile-time guard against silent two-copy drift (AGENTS §5)', () => {
		expectTypeOf<Infer<typeof workspaceToolShape>>().toEqualTypeOf<WorkspaceOperation>()
	})

	const valid: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
		['read', { operation: 'read', path: 'a.ts' }],
		['list', { operation: 'list' }],
		['has', { operation: 'has', path: 'a.ts' }],
		['search', { operation: 'search', query: 'x' }],
		[
			'search with options',
			{ operation: 'search', query: 'x', regex: true, exact: false, limit: 3 },
		],
		['replace', { operation: 'replace', query: 'x', replacement: 'y' }],
		['write', { operation: 'write', path: 'a.ts', content: 'x' }],
		[
			'splice',
			{
				operation: 'splice',
				path: 'a.ts',
				content: 'x',
				fromLine: 1,
				fromColumn: 1,
				toLine: 1,
				toColumn: 2,
			},
		],
		['prepend', { operation: 'prepend', path: 'a.ts', content: 'x' }],
		['append', { operation: 'append', path: 'a.ts', content: 'x' }],
		['move', { operation: 'move', from: 'a.ts', to: 'b.ts' }],
		['remove', { operation: 'remove', path: 'a.ts' }],
		['workspaces', { operation: 'workspaces' }],
		['switch', { operation: 'switch', id: 'w1' }],
	]

	for (const [label, value] of valid) {
		it(`is() accepts a valid '${label}' operation`, () => {
			expect(contract.is(value)).toBe(true)
		})
		it(`parse() returns '${label}' unchanged`, () => {
			expect(contract.parse(value)).toEqual(value)
		})
	}

	it('is() rejects an unknown operation literal', () => {
		expect(contract.is({ operation: 'destroy', path: 'a.ts' })).toBe(false)
	})

	it('is() rejects a missing operation, or a variant missing its required field', () => {
		expect(contract.is({ path: 'a.ts' })).toBe(false)
		expect(contract.is({ operation: 'read' })).toBe(false)
		expect(contract.is({ operation: 'write', path: 'a.ts' })).toBe(false)
	})

	it('is() rejects a splice with a non-positive-integer caret component', () => {
		expect(
			contract.is({
				operation: 'splice',
				path: 'a.ts',
				content: 'x',
				fromLine: 0,
				fromColumn: 1,
				toLine: 1,
				toColumn: 1,
			}),
		).toBe(false)
		expect(
			contract.is({
				operation: 'splice',
				path: 'a.ts',
				content: 'x',
				fromLine: 1.5,
				fromColumn: 1,
				toLine: 1,
				toColumn: 1,
			}),
		).toBe(false)
	})

	it('is() rejects a search with a non-boolean regex/exact or a sub-1 limit', () => {
		expect(contract.is({ operation: 'search', query: 'x', regex: 'yes' })).toBe(false)
		expect(contract.is({ operation: 'search', query: 'x', exact: 'no' })).toBe(false)
		expect(contract.is({ operation: 'search', query: 'x', limit: 0 })).toBe(false)
	})

	it('generate() produces a value its own guard accepts (round-trip parity)', () => {
		const generated = contract.generate()
		expect(contract.is(generated)).toBe(true)
		expect(contract.parse(generated)).toEqual(generated)
	})

	it('the compiled JSON Schema is an anyOf union whose splice arm carries FOUR FLAT ints (no nested range)', () => {
		const anyOf = contract.schema.anyOf
		expect(Array.isArray(anyOf)).toBe(true)
		const arms: readonly unknown[] = Array.isArray(anyOf) ? anyOf : []
		const splice = arms.find((arm) => {
			const properties = isRecord(arm) ? arm.properties : undefined
			const operation = isRecord(properties) ? properties.operation : undefined
			const constValue = isRecord(operation) ? operation.const : undefined
			const enumValues = isRecord(operation) ? operation.enum : undefined
			return constValue === 'splice' || (Array.isArray(enumValues) && enumValues.includes('splice'))
		})
		const spliceProps = isRecord(splice) ? splice.properties : undefined
		expect(isRecord(spliceProps) ? Object.keys(spliceProps).sort() : []).toEqual([
			'content',
			'fromColumn',
			'fromLine',
			'operation',
			'path',
			'toColumn',
			'toLine',
		])
		expect(isRecord(spliceProps) ? 'range' in spliceProps : true).toBe(false)
	})
})

describe('databaseToolShape — the 12-op discriminated union', () => {
	const contract = createContract(databaseToolShape)

	const valid: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
		[
			'create',
			{
				operation: 'create',
				id: 'db1',
				tables: {
					users: { columns: { name: 'string', age: { type: 'integer', optional: true } } },
				},
			},
		],
		['tables', { operation: 'tables', id: 'db1' }],
		['get', { operation: 'get', id: 'db1', table: 'users', key: '1' }],
		[
			'records',
			{
				operation: 'records',
				id: 'db1',
				table: 'users',
				criteria: {
					conditions: [{ column: 'age', operator: 'above', values: [18] }],
					order: [{ column: 'age', direction: 'ascending' }],
					limit: 10,
					offset: 0,
				},
			},
		],
		['count', { operation: 'count', id: 'db1', table: 'users' }],
		[
			'aggregate',
			{ operation: 'aggregate', id: 'db1', table: 'users', function: 'sum', column: 'age' },
		],
		['add', { operation: 'add', id: 'db1', table: 'users', row: { name: 'a' } }],
		['set', { operation: 'set', id: 'db1', table: 'users', row: [{ name: 'a' }] }],
		[
			'update',
			{ operation: 'update', id: 'db1', table: 'users', key: '1', changes: { name: 'b' } },
		],
		['remove', { operation: 'remove', id: 'db1', table: 'users', key: '1' }],
		[
			'migrate',
			{
				operation: 'migrate',
				id: 'db1',
				tables: { users: { columns: { name: 'string' } } },
			},
		],
		['destroy', { operation: 'destroy', id: 'db1' }],
	]

	for (const [label, value] of valid) {
		it(`is() accepts a valid '${label}' operation`, () => {
			expect(contract.is(value)).toBe(true)
		})
		it(`parse() returns '${label}' unchanged`, () => {
			expect(contract.parse(value)).toEqual(value)
		})
	}

	it('is() accepts the SERIALIZED condition form ({ column, operator, values, connector })', () => {
		expect(
			contract.is({
				operation: 'records',
				id: 'db1',
				table: 'users',
				criteria: {
					conditions: [{ column: 'age', operator: 'above', values: [18], connector: 'and' }],
				},
			}),
		).toBe(true)
	})

	it('is() REJECTS the FLUENT condition form ({ column, from }) — a fluent-shaped condition is not a valid SERIALIZED condition', () => {
		expect(
			contract.is({
				operation: 'records',
				id: 'db1',
				table: 'users',
				criteria: { conditions: [{ column: 'age', from: 18 }] },
			}),
		).toBe(false)
	})

	it('is() rejects an operator outside the 15-literal union', () => {
		expect(
			contract.is({
				operation: 'records',
				id: 'db1',
				table: 'users',
				criteria: { conditions: [{ column: 'age', operator: 'contains', values: ['x'] }] },
			}),
		).toBe(false)
	})

	it('is() rejects a direction outside ascending/descending', () => {
		expect(
			contract.is({
				operation: 'records',
				id: 'db1',
				table: 'users',
				criteria: { order: [{ column: 'age', direction: 'up' }] },
			}),
		).toBe(false)
	})

	it('is() rejects an aggregate function outside the 5 literals', () => {
		expect(
			contract.is({
				operation: 'aggregate',
				id: 'db1',
				table: 'users',
				function: 'median',
				column: 'age',
			}),
		).toBe(false)
	})

	it('is() accepts a bare-kind column and a { type, optional } column in a TableSpec', () => {
		expect(
			contract.is({
				operation: 'create',
				id: 'db1',
				tables: {
					users: { columns: { name: 'string', age: { type: 'integer', optional: true } } },
				},
			}),
		).toBe(true)
	})

	it('is() rejects an unknown column kind string in a TableSpec', () => {
		expect(
			contract.is({
				operation: 'create',
				id: 'db1',
				tables: { users: { columns: { name: 'text' } } },
			}),
		).toBe(false)
	})

	it('is() rejects a missing discriminant or an unknown operation', () => {
		expect(contract.is({ id: 'db1', table: 'users' })).toBe(false)
		expect(contract.is({ operation: 'drop', id: 'db1' })).toBe(false)
	})

	it('is() accepts a key as a string, a number, or an array of both', () => {
		expect(contract.is({ operation: 'get', id: 'db1', table: 'users', key: '1' })).toBe(true)
		expect(contract.is({ operation: 'get', id: 'db1', table: 'users', key: 1 })).toBe(true)
		expect(contract.is({ operation: 'get', id: 'db1', table: 'users', key: ['1', 2] })).toBe(true)
	})

	it('generate() produces a value its own guard accepts (round-trip parity)', () => {
		const generated = contract.generate()
		expect(contract.is(generated)).toBe(true)
		expect(contract.parse(generated)).toEqual(generated)
	})
})

describe('relationToolShape — the 5-op discriminated union', () => {
	const contract = createContract(relationToolShape)

	const valid: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
		['load', { operation: 'load', model: 'users', key: '1' }],
		[
			'load with include',
			{ operation: 'load', model: 'users', key: '1', include: ['contacts', 'contacts.account'] },
		],
		['find', { operation: 'find', model: 'users' }],
		[
			'find with options',
			{
				operation: 'find',
				model: 'users',
				include: ['contacts'],
				limit: 10,
				offset: 0,
				sort: 'name',
				direction: 'ascending',
			},
		],
		['link', { operation: 'link', model: 'users', key: '1', relation: 'contacts', target: '2' }],
		[
			'unlink',
			{ operation: 'unlink', model: 'users', key: '1', relation: 'contacts', target: '2' },
		],
		['links', { operation: 'links', model: 'users', key: '1', relation: 'contacts' }],
	]

	for (const [label, value] of valid) {
		it(`is() accepts a valid '${label}' operation`, () => {
			expect(contract.is(value)).toBe(true)
		})
		it(`parse() returns '${label}' unchanged`, () => {
			expect(contract.parse(value)).toEqual(value)
		})
	}

	it('is() accepts include as a flat string array', () => {
		expect(
			contract.is({ operation: 'load', model: 'users', key: '1', include: ['contacts.account'] }),
		).toBe(true)
	})

	it('is() rejects a link/unlink missing key, relation, or target', () => {
		expect(
			contract.is({ operation: 'link', model: 'users', relation: 'contacts', target: '2' }),
		).toBe(false)
		expect(contract.is({ operation: 'link', model: 'users', key: '1', target: '2' })).toBe(false)
		expect(contract.is({ operation: 'link', model: 'users', key: '1', relation: 'contacts' })).toBe(
			false,
		)
		expect(
			contract.is({ operation: 'unlink', model: 'users', relation: 'contacts', target: '2' }),
		).toBe(false)
		expect(contract.is({ operation: 'unlink', model: 'users', key: '1', target: '2' })).toBe(false)
		expect(
			contract.is({ operation: 'unlink', model: 'users', key: '1', relation: 'contacts' }),
		).toBe(false)
	})

	it('is() rejects an unknown operation literal', () => {
		expect(contract.is({ operation: 'delete', model: 'users', key: '1' })).toBe(false)
	})

	it('generate() produces a value its own guard accepts (round-trip parity)', () => {
		const generated = contract.generate()
		expect(contract.is(generated)).toBe(true)
		expect(contract.parse(generated)).toEqual(generated)
	})
})
