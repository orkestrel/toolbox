import type { ColumnSpec, DatabaseDefinition } from '@src/core'
import { createMemoryDefinitionStore } from '@src/core'
import { createTestDefinition } from '../../../setup.js'
import { describe, expect, it } from 'vitest'

// tests/src/core/stores/MemoryDefinitionStore.test.ts — mirrors src/core/stores/MemoryDefinitionStore.ts.
// The store is one half of a twin pair: it shares the `DefinitionStoreInterface` contract with
// DatabaseDefinitionStore, so the scenarios below are the SAME contract scenarios its twin's test
// runs (AGENTS §5 — Stores: point-access, own-id set, no-op delete-of-absent), asserted here
// against the plain-Map tier.

describe('MemoryDefinitionStore — DefinitionStoreInterface conformance', () => {
	it('set→get round-trips the FULL definition (mixed columns, primary, indexes, and version)', async () => {
		const store = createMemoryDefinitionStore()
		const definition = createTestDefinition()
		await store.set(definition)
		expect(await store.get('shop')).toEqual(definition)
	})

	it('set upserts by id — a second set for the SAME id replaces the first', async () => {
		const store = createMemoryDefinitionStore()
		await store.set(createTestDefinition())
		const replacement: DatabaseDefinition = {
			id: 'shop',
			driver: 'memory',
			tables: { orders: { columns: { id: 'string' } } },
		}
		await store.set(replacement)
		expect(await store.get('shop')).toEqual(replacement)
	})

	it('get of an absent id resolves undefined', async () => {
		const store = createMemoryDefinitionStore()
		expect(await store.get('missing')).toBeUndefined()
	})

	it('delete removes a stored definition', async () => {
		const store = createMemoryDefinitionStore()
		await store.set(createTestDefinition())
		await store.delete('shop')
		expect(await store.get('shop')).toBeUndefined()
	})

	it('delete of an absent id is a silent no-op (does not throw)', async () => {
		const store = createMemoryDefinitionStore()
		await expect(store.delete('never-existed')).resolves.toBeUndefined()
	})

	it('a definition with no `primary` field round-trips WITHOUT gaining one', async () => {
		const store = createMemoryDefinitionStore()
		const definition: DatabaseDefinition = {
			id: 'no-primary',
			driver: 'memory',
			tables: { items: { columns: { id: 'string' } } },
		}
		await store.set(definition)
		const read = await store.get('no-primary')
		expect(read).toEqual(definition)
		expect(read !== undefined && 'primary' in read).toBe(false)
	})

	it('isolates stored state from mutable inputs and mutated readonly results', async () => {
		const columns: Record<string, ColumnSpec> = {
			id: 'string',
			name: 'string',
			price: { type: 'number', optional: true },
		}
		const tables: Record<string, { columns: Record<string, ColumnSpec> }> = {
			items: { columns },
		}
		const primary: Record<string, string> = { items: 'id' }
		const indexes: Record<string, string[][]> = { items: [['name'], ['name', 'price']] }
		const definition = { id: 'shop', driver: 'memory', tables, primary, indexes, version: 3.5 }

		const store = createMemoryDefinitionStore()
		await store.set(definition)
		columns.name = 'boolean'
		primary.items = 'name'
		indexes.items = [['price']]
		definition.version = 8
		expect(await store.get('shop')).toEqual(createTestDefinition())

		const returned = await store.get('shop')
		if (
			returned === undefined ||
			returned.primary === undefined ||
			returned.indexes === undefined
		) {
			throw new Error('expected a full stored definition')
		}
		expect(Reflect.set(returned.tables, 'items', { columns: { changed: 'string' } })).toBe(true)
		expect(Reflect.set(returned.primary, 'items', 'changed')).toBe(true)
		expect(Reflect.set(returned.indexes, 'items', [['changed']])).toBe(true)
		expect(Reflect.set(returned, 'version', 9)).toBe(true)
		expect(await store.get('shop')).toEqual(createTestDefinition())
	})
})
