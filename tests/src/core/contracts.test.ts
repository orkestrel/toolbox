import { createContract, seededRandom } from '@orkestrel/contract'
import {
	columnPrimitiveShape,
	columnSpecShape,
	tableSpecShape,
	primaryShape,
	indexesShape,
	definitionContract,
	isColumnPrimitive,
	isColumnSpec,
	isTableSpec,
	isPrimaryMap,
	isIndexMap,
	isDatabaseDefinition,
	createDatabaseDefinitionStore,
} from '@src/core'
import { describe, expect, it } from 'vitest'

describe('standing guard contract table', () => {
	const rows = [
		{
			name: 'column primitive',
			wire: createContract(columnPrimitiveShape),
			guard: isColumnPrimitive,
			positive: 'string',
			negative: 'date',
		},
		{
			name: 'column spec',
			wire: createContract(columnSpecShape),
			guard: isColumnSpec,
			positive: { primitive: 'integer', optional: true },
			negative: { primitive: 'date' },
		},
		{
			name: 'table spec',
			wire: createContract(tableSpecShape),
			guard: isTableSpec,
			positive: { users: { columns: { id: 'integer' } } },
			negative: { users: {} },
		},
		{
			name: 'primary',
			wire: createContract(primaryShape),
			guard: isPrimaryMap,
			positive: { users: 'id' },
			negative: { users: '' },
		},
		{
			name: 'indexes',
			wire: createContract(indexesShape),
			guard: isIndexMap,
			positive: { users: [['id']] },
			negative: { users: [[]] },
		},
		{
			name: 'definition',
			wire: definitionContract,
			guard: isDatabaseDefinition,
			positive: { id: 'shop', driver: 'memory', tables: {} },
			negative: { id: '', driver: 'memory', tables: {} },
		},
	].map((row) => ({ ...row, direction: 'is implies guard', project: undefined }))

	it.each(rows)('$name: canonical controls and generated admissions imply guard', (row) => {
		expect(row.direction).toBe('is implies guard')
		expect(row.project).toBeUndefined()
		expect(row.wire.is(row.positive)).toBe(true)
		expect(row.guard(row.positive)).toBe(true)
		expect(row.wire.is(row.negative)).toBe(false)
		expect(row.guard(row.negative)).toBe(false)
		const generated = Array.from({ length: 100 }, (_, seed) => {
			const value = row.wire.generate(seededRandom(seed))
			return { seed, admitted: row.wire.is(value), guarded: row.guard(value) }
		})
		expect(generated.filter((entry) => !entry.admitted)).toEqual([])
		expect(generated.filter((entry) => !entry.guarded)).toEqual([])
	})

	it('owned definitions pass the wire and survive storage restoration', async () => {
		const definition = { id: 'shop', driver: 'memory', tables: {} }
		const store = createDatabaseDefinitionStore()
		expect(definitionContract.is(definition)).toBe(true)
		await store.set(definition)
		expect(await store.get('shop')).toEqual(definition)
	})
})
