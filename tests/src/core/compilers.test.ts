import { compileColumn, compileColumnKind, expandTables } from '@src/core'
import { createContract, objectShape } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'

// tests/src/core/compilers.test.ts — mirrors src/core/compilers.ts. The config-only TableSpec
// column DSL compiled into a live `@orkestrel/database` TableMap: the composite walk and the two
// leaves it maps with, each asserted through a real compiled contract rather than shape identity.

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

describe('compileColumn — compile one ColumnSpec into its column shape', () => {
	it('compiles a bare ColumnKind shorthand into the required primitive shape', () => {
		const contract = createContract(objectShape({ value: compileColumn('integer') }))
		expect(contract.is({ value: 3 })).toBe(true)
		expect(contract.is({ value: 3.5 })).toBe(false)
		expect(contract.is({})).toBe(false)
	})

	it('compiles { type } without optional into the same required shape as the shorthand', () => {
		const contract = createContract(objectShape({ value: compileColumn({ type: 'string' }) }))
		expect(contract.is({ value: 'x' })).toBe(true)
		expect(contract.is({})).toBe(false)
	})

	it('wraps an optional:true column so an absent value passes and a wrong-typed one fails', () => {
		const contract = createContract(
			objectShape({ value: compileColumn({ type: 'number', optional: true }) }),
		)
		expect(contract.is({})).toBe(true)
		expect(contract.is({ value: 1.5 })).toBe(true)
		expect(contract.is({ value: 'x' })).toBe(false)
	})

	it('treats optional:false as required, matching the shorthand', () => {
		const contract = createContract(
			objectShape({ value: compileColumn({ type: 'boolean', optional: false }) }),
		)
		expect(contract.is({ value: false })).toBe(true)
		expect(contract.is({})).toBe(false)
	})
})

describe('compileColumnKind — compile one ColumnKind into its primitive shape', () => {
	it('maps every kind to a shape accepting its own value and rejecting a record', () => {
		const samples = { string: 'x', integer: 3, number: 1.5, boolean: true } as const
		const kinds = ['string', 'integer', 'number', 'boolean'] as const
		for (const kind of kinds) {
			const contract = createContract(objectShape({ value: compileColumnKind(kind) }))
			expect(contract.is({ value: samples[kind] })).toBe(true)
			expect(contract.is({ value: { nested: true } })).toBe(false)
			expect(contract.is({})).toBe(false)
		}
	})

	it('separates integer from number: a fractional value fails the integer shape alone', () => {
		const integer = createContract(objectShape({ value: compileColumnKind('integer') }))
		const number = createContract(objectShape({ value: compileColumnKind('number') }))
		expect(integer.is({ value: 1.5 })).toBe(false)
		expect(number.is({ value: 1.5 })).toBe(true)
		expect(integer.is({ value: 2 })).toBe(true)
	})
})
