import type { ColumnSpec, DatabaseDefinition } from '@src/core'
import { createDatabaseDefinitionStore, isToolboxError } from '@src/core'
import { captureToolboxFailure } from '../../../setup.js'
import { createTestDefinition, buildDatabaseStoreWithTable } from '../../../setup.js'
import { describe, expect, it } from 'vitest'

// tests/src/core/stores/DatabaseDefinitionStore.test.ts — mirrors src/core/stores/DatabaseDefinitionStore.ts.
// The store is one half of a twin pair: it shares the `DefinitionStoreInterface` contract with
// MemoryDefinitionStore, so the conformance scenarios below are the SAME contract scenarios its
// twin's test runs (AGENTS' Stores rule — point-access, own-id set, no-op delete-of-absent),
// asserted here against the driver-pluggable tier. Database-only scenarios (default driver,
// malformed stored blob) follow in their own sections.

// The malformed-blob section takes a store PLUS a handle to its underlying table, so a test can
// write junk directly into storage (reaching it without the store's own `set`) to prove a present
// row the guard refuses throws rather than reading as absent.

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
	it('get throws DATABASE when the underlying row holds a non-definition blob, carrying its faults', async () => {
		const { store, table } = buildDatabaseStoreWithTable()
		await table.set({ id: 'junk', definition: { totally: 'not a definition' } })
		const error = await captureToolboxFailure(() => store.get('junk'))
		expect(isToolboxError(error) ? error.code : undefined).toBe('DATABASE')
		expect(isToolboxError(error) ? error.context?.id : undefined).toBe('junk')
		expect(isToolboxError(error) ? error.context?.faults : undefined).toEqual(
			expect.arrayContaining([{ reason: 'extra', path: ['totally'] }]),
		)
		expect(error instanceof Error ? error.message : '').toContain('store.delete("junk")')
	})

	it('get throws DATABASE when the underlying row holds a primitive (non-record) blob', async () => {
		const { store, table } = buildDatabaseStoreWithTable()
		await table.set({ id: 'junk-primitive', definition: 'just a string' })
		const error = await captureToolboxFailure(() => store.get('junk-primitive'))
		expect(isToolboxError(error) ? error.code : undefined).toBe('DATABASE')
	})

	it('an undeclared key names the key, the table, and the remedy', async () => {
		const { store, table } = buildDatabaseStoreWithTable()
		await table.set({
			id: 'shop',
			definition: { ...createTestDefinition(), keys: { items: 'id' } },
		})
		const error = await captureToolboxFailure(() => store.get('shop'))
		expect(isToolboxError(error) ? error.context?.faults : undefined).toEqual([
			{ reason: 'extra', path: ['keys'] },
		])
		const text = error instanceof Error ? error.message : ''
		expect(text).toContain('extra key "keys" at the root')
		expect(text).toContain('read the row through your own table')
		expect(text).toContain('rewrite it without the key')
		expect(text).toContain('store.delete("shop")')
	})

	it('a row that names another id throws, naming the fault at id', async () => {
		const { store, table } = buildDatabaseStoreWithTable()
		await table.set({ id: 'shop', definition: createTestDefinition('other') })
		const error = await captureToolboxFailure(() => store.get('shop'))
		expect(isToolboxError(error) ? error.code : undefined).toBe('DATABASE')
		expect(isToolboxError(error) ? error.context?.faults : undefined).toEqual([
			{ reason: 'type', path: ['id'], expected: 'literal', received: '"other"' },
		])
		const text = error instanceof Error ? error.message : ''
		expect(text).toContain('names id "other"')
		expect(text).toContain('must be "shop"')
		expect(text).toContain('store.delete("shop")')
		expect(text).not.toContain('declared shape')
	})

	it('a mismatched row with a long id stays bounded and encodes it', async () => {
		const { store, table } = buildDatabaseStoreWithTable()
		await table.set({ id: 'shop', definition: createTestDefinition(`${'o'.repeat(5000)}\nfake`) })
		const error = await captureToolboxFailure(() => store.get('shop'))
		const text = error instanceof Error ? error.message : ''
		expect(text.length).toBeLessThanOrEqual(2048)
		expect(text).not.toContain('\nfake')
	})

	it('a refused set with many undeclared keys stays capped', async () => {
		const { store } = buildDatabaseStoreWithTable()
		const extras = Object.fromEntries(
			Array.from({ length: 200 }, (_, index) => [`key-${index}`, index]),
		)
		const error = await captureToolboxFailure(() =>
			Reflect.apply(store.set, store, [{ ...createTestDefinition(), ...extras }]),
		)
		expect(isToolboxError(error) ? error.code : undefined).toBe('DATABASE')
		expect((error instanceof Error ? error.message : '').length).toBeLessThanOrEqual(2048)
	})

	it('only a missing row reads undefined', async () => {
		const { store } = buildDatabaseStoreWithTable()
		await expect(store.get('absent')).resolves.toBeUndefined()
	})

	it('set refuses what get would and writes nothing', async () => {
		const { store, table } = buildDatabaseStoreWithTable()
		const malformed: unknown = { ...createTestDefinition(), keys: { items: 'id' } }
		const error = await captureToolboxFailure(() => Reflect.apply(store.set, store, [malformed]))
		expect(isToolboxError(error) ? error.code : undefined).toBe('DATABASE')
		expect(isToolboxError(error) ? error.context?.faults : undefined).toEqual([
			{ reason: 'extra', path: ['keys'] },
		])
		expect(error instanceof Error ? error.message : '').toContain('keys: extra')
		await expect(table.get('shop')).resolves.toBeUndefined()
	})

	it('delete clears a refused row without reading it, so get reads undefined afterwards', async () => {
		const { store, table } = buildDatabaseStoreWithTable()
		await table.set({ id: 'junk', definition: 'just a string' })
		await store.delete('junk')
		await expect(store.get('junk')).resolves.toBeUndefined()
	})
})
