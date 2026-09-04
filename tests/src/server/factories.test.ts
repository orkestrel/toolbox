import { createTerminalManager } from '@orkestrel/terminal'
import { createTerminalRoutes } from '@src/server'
import { describe, expect, it } from 'vitest'

// tests/src/server/factories.test.ts — mirrors src/server/factories.ts. The factory's own contract
// is the pair of route records it projects; the bridge behaviour those handlers carry is proven in
// tests/src/server/terminals/TerminalBridge.test.ts.

describe('createTerminalRoutes', () => {
	it('returns exactly two routes, GET and POST, on the same path', () => {
		const manager = createTerminalManager()
		const routes = createTerminalRoutes(manager)
		expect(routes).toHaveLength(2)
		expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'POST'])
		expect(new Set(routes.map((r) => r.path)).size).toBe(1)
	})
})
