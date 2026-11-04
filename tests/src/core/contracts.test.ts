import { seededRandom } from '@orkestrel/contract'
import { definitionContract, createDatabaseDefinitionStore } from '@src/core'
import { buildToolboxContractCases } from '../../setup.js'
import { describe, expect, it } from 'vitest'

describe('standing guard contract table', () => {
	it.each(buildToolboxContractCases())(
		'$name: canonical controls and generated admissions imply guard',
		(row) => {
			for (const value of [
				row.positive,
				row.negative,
				undefined,
				null,
				{},
				[],
				Number.NaN,
				new Date(0),
			]) {
				expect(row.direction(value)).toBe(true)
			}
			expect(row.wire.is(row.positive)).toBe(true)
			expect(row.guard(row.positive)).toBe(true)
			expect(row.wire.is(row.negative)).toBe(false)
			expect(row.guard(row.negative)).toBe(false)
			const generated = Array.from({ length: 100 }, (_, seed) => {
				const value = row.wire.generate(seededRandom(seed))
				return { seed, admitted: row.wire.is(value), guarded: row.direction(value) }
			})
			expect(generated.filter((entry) => !entry.admitted)).toEqual([])
			expect(generated.filter((entry) => !entry.guarded)).toEqual([])
		},
	)

	it('owned definitions pass the wire and survive storage restoration', async () => {
		const definition = { id: 'shop', driver: 'memory', tables: {} }
		const store = createDatabaseDefinitionStore()
		expect(definitionContract.is(definition)).toBe(true)
		await store.set(definition)
		expect(await store.get('shop')).toEqual(definition)
	})
})
