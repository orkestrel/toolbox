import type { DatabaseInterface } from '@orkestrel/database'
import { createMemoryDriver } from '@orkestrel/database'
import { createMemoryDefinitionStore, DatabaseResolver, isToolboxError } from '@src/core'
import { createTestDatabase } from '../../../setup.js'
import { describe, expect, it } from 'vitest'

describe('DatabaseResolver', () => {
	it('copies initial handles and owns subsequent cache mutations', async () => {
		const seeded = createTestDatabase()
		const added = createTestDatabase()
		const handles = new Map<string, DatabaseInterface>([['seeded', seeded]])
		const resolver = new DatabaseResolver(handles, { memory: createMemoryDriver })

		expect(resolver.has('seeded')).toBe(true)
		expect(resolver.get('seeded')).toBe(seeded)
		resolver.set('added', added)
		expect(resolver.get('added')).toBe(added)
		expect(handles.has('added')).toBe(false)
		resolver.delete('added')
		expect(resolver.has('added')).toBe(false)

		await seeded.close()
		await added.close()
	})

	it('constructs and caches a named stored definition with all schema configuration', async () => {
		const store = createMemoryDefinitionStore()
		const driver = createMemoryDriver()
		await store.set({
			id: 'shop',
			driver: 'memory',
			tables: { items: { columns: { code: 'string', name: 'string' } } },
			primary: { items: 'code' },
			indexes: { items: [['name']] },
			version: 4,
		})
		const handles = new Map<string, DatabaseInterface>()
		const resolver = new DatabaseResolver(
			handles,
			{ memory: () => driver },
			() => 'generated',
			store,
		)

		const database = await resolver.resolve('shop')
		expect(database.name).toBe('shop')
		expect(database.export().items?.primary).toBe('code')
		expect(await database.table('items').add({ name: 'generated row' })).toBe('generated')
		expect(await database.table('items').get('generated')).toEqual({
			code: 'generated',
			name: 'generated row',
		})
		if (driver.metadata === undefined) throw new Error('expected MemoryDriver metadata capability')
		const metadata = await driver.metadata()
		expect(metadata?.version).toBe(4)
		expect(metadata?.schema[0]?.indexes).toEqual([['name']])
		expect(await resolver.resolve('shop')).toBe(database)
		expect(handles.has('shop')).toBe(false)

		await database.close()
	})

	it('throws a typed tool error for an unknown database', async () => {
		const resolver = new DatabaseResolver(new Map(), { memory: createMemoryDriver })

		let caught: unknown
		try {
			await resolver.resolve('missing')
		} catch (error) {
			caught = error
		}
		expect(isToolboxError(caught)).toBe(true)
		expect(isToolboxError(caught) ? caught.code : undefined).toBe('TOOL')
	})
})
