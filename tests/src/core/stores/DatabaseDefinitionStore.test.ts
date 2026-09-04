import type {
	ColumnSpec,
	DatabaseDefinition,
	DatabaseDefinitionRow,
	DefinitionStoreInterface,
} from '@src/core'
import type { TableInterface } from '@orkestrel/database'
import {
	createDatabaseDefinitionStore,
	DatabaseDefinitionStore,
	isDatabaseDefinition,
} from '@src/core'
import { rawShape, stringShape } from '@orkestrel/contract'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { createTestDefinition } from '../../../setup.js'
import { describe, expect, it } from 'vitest'

// tests/src/core/stores/DatabaseDefinitionStore.test.ts — mirrors src/core/stores/DatabaseDefinitionStore.ts.
// The store is one half of a twin pair: it shares the `DefinitionStoreInterface` contract with
// MemoryDefinitionStore, so the conformance scenarios below are the SAME contract scenarios its
// twin's test runs (AGENTS' Stores rule — point-access, own-id set, no-op delete-of-absent),
// asserted here against the driver-pluggable tier. Database-only scenarios (default driver,
// malformed stored blob) follow in their own sections.

// Builds a fresh DatabaseDefinitionStore PLUS a handle to its underlying table, so a test can
// write junk directly into storage (bypassing the store's own `set`) to prove a malformed
// stored blob resolves `undefined` rather than throwing.
function buildDatabaseStoreWithTable(): {
	readonly store: DefinitionStoreInterface
	readonly table: TableInterface<DatabaseDefinitionRow>
} {
	const columns = { id: stringShape(), definition: rawShape({}) }
	const database = createDatabase({
		driver: createMemoryDriver(),
		tables: { definitions: columns },
	})
	const table: TableInterface<DatabaseDefinitionRow> = database.table('definitions')
	return { store: new DatabaseDefinitionStore(table), table }
}

describe('DatabaseDefinitionStore — DefinitionStoreInterface conformance', () => {
	it('set→get round-trips the FULL definition (mixed columns, primary, indexes, and version)', async () => {
		const store = createDatabaseDefinitionStore()
		const definition = createTestDefinition()
		await store.set(definition)
		expect(await store.get('shop')).toEqual(definition)
	})

	it('set upserts by id — a second set for the SAME id replaces the first', async () => {
		const store = createDatabaseDefinitionStore()
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
		const store = createDatabaseDefinitionStore()
		expect(await store.get('missing')).toBeUndefined()
	})

	it('delete removes a stored definition', async () => {
		const store = createDatabaseDefinitionStore()
		await store.set(createTestDefinition())
		await store.delete('shop')
		expect(await store.get('shop')).toBeUndefined()
	})

	it('delete of an absent id is a silent no-op (does not throw)', async () => {
		const store = createDatabaseDefinitionStore()
		await expect(store.delete('never-existed')).resolves.toBeUndefined()
	})

	it('a definition with no `primary` field round-trips WITHOUT gaining one', async () => {
		const store = createDatabaseDefinitionStore()
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
			price: { primitive: 'number', optional: true },
		}
		const tables: Record<string, { columns: Record<string, ColumnSpec> }> = {
			items: { columns },
		}
		const primary: Record<string, string> = { items: 'id' }
		const indexes: Record<string, string[][]> = { items: [['name'], ['name', 'price']] }
		const definition = { id: 'shop', driver: 'memory', tables, primary, indexes, version: 3.5 }

		const store = createDatabaseDefinitionStore()
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

describe('createDatabaseDefinitionStore — default driver', () => {
	it('constructs and works with NO driver argument (defaults to an in-memory driver)', async () => {
		const store = createDatabaseDefinitionStore()
		await store.set(createTestDefinition('default-driver'))
		expect(await store.get('default-driver')).toEqual(createTestDefinition('default-driver'))
	})
})

describe('DatabaseDefinitionStore — malformed stored blob', () => {
	it('get resolves undefined (not a throw) when the underlying row holds a non-definition blob', async () => {
		const { store, table } = buildDatabaseStoreWithTable()
		await table.set({ id: 'junk', definition: { totally: 'not a definition' } })
		expect(isDatabaseDefinition({ totally: 'not a definition' })).toBe(false)
		await expect(store.get('junk')).resolves.toBeUndefined()
	})

	it('get resolves undefined when the underlying row holds a primitive (non-record) blob', async () => {
		const { store, table } = buildDatabaseStoreWithTable()
		await table.set({ id: 'junk-primitive', definition: 'just a string' })
		await expect(store.get('junk-primitive')).resolves.toBeUndefined()
	})
})
