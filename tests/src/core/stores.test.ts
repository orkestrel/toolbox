import type { DatabaseDefinition, DatabaseDefinitionRow, DefinitionStoreInterface } from '@src/core'
import type { TableInterface } from '@orkestrel/database'
import {
	createDatabaseDefinitionStore,
	createMemoryDefinitionStore,
	DatabaseDefinitionStore,
	isDatabaseDefinition,
} from '@src/core'
import { rawShape, stringShape } from '@orkestrel/contract'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { describe, expect, it } from 'vitest'

// tests/src/core/stores.test.ts — mirrors src/core/stores/{MemoryDefinitionStore,DatabaseDefinitionStore}.ts.
// Both twins share the SAME `DefinitionStoreInterface` contract, so every scenario below runs
// against BOTH twins to pin identical behavior (AGENTS §5 — Stores: point-access, own-id set,
// no-op delete-of-absent). Database-only scenarios (malformed blob, driver-less construction)
// follow in their own section.

function fullDefinition(id = 'shop'): DatabaseDefinition {
	return {
		id,
		driver: 'memory',
		tables: {
			items: {
				columns: {
					id: 'string',
					price: { type: 'number', optional: true },
					name: 'string',
				},
			},
		},
		keys: { items: 'id' },
	}
}

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

const twins: ReadonlyArray<{
	readonly name: string
	readonly build: () => DefinitionStoreInterface
}> = [
	{ name: 'MemoryDefinitionStore', build: () => createMemoryDefinitionStore() },
	{ name: 'DatabaseDefinitionStore', build: () => createDatabaseDefinitionStore() },
]

describe.each(twins)('$name — DefinitionStoreInterface conformance', ({ build }) => {
	it('set→get round-trips the FULL definition (mixed bare-kind and {type,optional} columns, keys)', async () => {
		const store = build()
		const definition = fullDefinition()
		await store.set(definition)
		expect(await store.get('shop')).toEqual(definition)
	})

	it('set upserts by id — a second set for the SAME id replaces the first', async () => {
		const store = build()
		await store.set(fullDefinition())
		const replacement: DatabaseDefinition = {
			id: 'shop',
			driver: 'memory',
			tables: { orders: { columns: { id: 'string' } } },
		}
		await store.set(replacement)
		expect(await store.get('shop')).toEqual(replacement)
	})

	it('get of an absent id resolves undefined', async () => {
		const store = build()
		expect(await store.get('missing')).toBeUndefined()
	})

	it('delete removes a stored definition', async () => {
		const store = build()
		await store.set(fullDefinition())
		await store.delete('shop')
		expect(await store.get('shop')).toBeUndefined()
	})

	it('delete of an absent id is a silent no-op (does not throw)', async () => {
		const store = build()
		await expect(store.delete('never-existed')).resolves.toBeUndefined()
	})

	it('a definition with no `keys` field round-trips WITHOUT gaining one', async () => {
		const store = build()
		const definition: DatabaseDefinition = {
			id: 'no-keys',
			driver: 'memory',
			tables: { items: { columns: { id: 'string' } } },
		}
		await store.set(definition)
		const read = await store.get('no-keys')
		expect(read).toEqual(definition)
		expect(read !== undefined && 'keys' in read).toBe(false)
	})
})

describe('createDatabaseDefinitionStore — default driver', () => {
	it('constructs and works with NO driver argument (defaults to an in-memory driver)', async () => {
		const store = createDatabaseDefinitionStore()
		await store.set(fullDefinition('default-driver'))
		expect(await store.get('default-driver')).toEqual(fullDefinition('default-driver'))
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
