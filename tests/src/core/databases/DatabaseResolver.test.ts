import type { DatabaseInterface } from '@orkestrel/database'
import { createMemoryDriver, generateUUID } from '@orkestrel/database'
import { createMemoryDefinitionStore, DatabaseResolver, isAgentToolError } from '@src/core'
import { createTestDatabase } from '../../../setup.js'
import { describe, expect, it } from 'vitest'

describe('DatabaseResolver', () => {
	it('copies initial handles and owns subsequent cache mutations', async () => {
		const seeded = createTestDatabase()
		const added = createTestDatabase()
		const handles = new Map<string, DatabaseInterface>([['seeded', seeded]])
		const resolver = new DatabaseResolver(handles, { memory: createMemoryDriver }, generateUUID)

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

	it('constructs and caches a stored definition without mutating caller state', async () => {
		const store = createMemoryDefinitionStore()
		await store.set({ id: 'shop', driver: 'memory', tables: {} })
		const handles = new Map<string, DatabaseInterface>()
		const resolver = new DatabaseResolver(
			handles,
			{ memory: createMemoryDriver },
			generateUUID,
			store,
		)

		const database = await resolver.resolve('shop')
		expect(database.export()).toEqual({})
		expect(await resolver.resolve('shop')).toBe(database)
		expect(handles.has('shop')).toBe(false)

		await database.close()
	})

	it('throws a typed tool error for an unknown database', async () => {
		const resolver = new DatabaseResolver(new Map(), { memory: createMemoryDriver }, generateUUID)

		let caught: unknown
		try {
			await resolver.resolve('missing')
		} catch (error) {
			caught = error
		}
		expect(isAgentToolError(caught)).toBe(true)
		expect(isAgentToolError(caught) ? caught.code : undefined).toBe('TOOL')
	})
})
