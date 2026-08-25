import { isProviderAbortError } from '@orkestrel/agent'
import { waitForAbort } from '@orkestrel/test'
import {
	createTestDatabase,
	createTestDefinition,
	createTestTaskController,
	MalformedAgent,
	RecordingWorkflowStore,
	ScriptedProvider,
} from './setup.js'
import { describe, expect, it } from 'vitest'

describe('setup', () => {
	it('createTestDatabase returns a fresh, closable live database on every call', async () => {
		const first = createTestDatabase()
		const second = createTestDatabase()

		expect(second).not.toBe(first)
		expect(first.name).toEqual(expect.any(String))
		await first.open()
		await first.close()
		await second.close()
	})

	it('createTestDefinition builds the fixed mixed-column, indexed, versioned fixture', () => {
		const definition = createTestDefinition()

		expect(definition).toEqual({
			id: 'shop',
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
			primary: { items: 'id' },
			indexes: { items: [['name'], ['name', 'price']] },
			version: 3.5,
		})
	})

	it('createTestDefinition threads a caller id through the same fixed shape', () => {
		const definition = createTestDefinition('warehouse')

		expect(definition.id).toBe('warehouse')
		expect(definition.tables).toEqual({
			items: {
				columns: {
					id: 'string',
					price: { type: 'number', optional: true },
					name: 'string',
				},
			},
		})
	})

	it('createTestTaskController wires a real controller over a p/t workflow with defaults', () => {
		const controller = createTestTaskController()

		expect(controller.input).toEqual({})
		expect(controller.aborted).toBe(false)
		expect(controller.attempt).toBe(1)
		expect(controller.results()).toEqual([])
	})

	it('createTestTaskController threads a caller signal and input into the real controller', async () => {
		const abortController = new AbortController()
		const controller = createTestTaskController({
			signal: abortController.signal,
			input: { path: '/repo' },
		})

		expect(controller.input).toEqual({ path: '/repo' })
		abortController.abort('stop')
		await waitForAbort(controller.signal)
		expect(controller.aborted).toBe(true)
	})

	it('RecordingWorkflowStore records committed snapshots and returns the last match by id', async () => {
		const store = new RecordingWorkflowStore()
		const first: Parameters<typeof store.set>[0] = {
			id: 'wf',
			name: 'wf',
			status: 'running',
			bail: false,
			phases: [],
			created: 1,
			updated: 1,
		}
		const second = { ...first, updated: 2 }

		await store.set(first)
		await store.set(second)

		expect(store.attempts).toBe(2)
		expect(await store.get('wf')).toEqual(second)
		await store.delete('wf')
		expect(await store.get('wf')).toBeUndefined()
	})

	it('RecordingWorkflowStore rejects the configured leading attempts before committing', async () => {
		const store = new RecordingWorkflowStore(2)
		const snapshot: Parameters<typeof store.set>[0] = {
			id: 'wf',
			name: 'wf',
			status: 'running',
			bail: false,
			phases: [],
			created: 1,
			updated: 1,
		}

		await expect(store.set(snapshot)).rejects.toThrow('checkpoint refused')
		await expect(store.set(snapshot)).rejects.toThrow('checkpoint refused')
		await store.set(snapshot)

		expect(store.attempts).toBe(3)
		expect(store.snapshots).toEqual([snapshot])
	})

	it('ScriptedProvider replays scripted turns in order and repeats the last one', async () => {
		const provider = new ScriptedProvider([{ content: 'first' }, { content: 'second' }])

		const one = await provider.generate(
			[{ id: 'm1', role: 'user', content: 'go' }],
			new AbortController().signal,
		)
		const two = await provider.generate(
			[{ id: 'm1', role: 'user', content: 'go' }],
			new AbortController().signal,
		)
		const three = await provider.generate(
			[{ id: 'm1', role: 'user', content: 'go' }],
			new AbortController().signal,
		)

		expect(one.content).toBe('first')
		expect(two.content).toBe('second')
		expect(three.content).toBe('second')
		expect(provider.started).toBe(3)
		expect(provider.calls).toHaveLength(3)
	})

	it('ScriptedProvider honours an already-aborted signal with a ProviderAbortError partial', async () => {
		const provider = new ScriptedProvider([{ content: 'unreached' }])
		const controller = new AbortController()
		controller.abort()

		const error = await provider.generate([], controller.signal).catch((caught: unknown) => caught)

		expect(isProviderAbortError(error)).toBe(true)
	})

	it('ScriptedProvider throws its configured failure instead of streaming', async () => {
		const failure = new Error('scripted failure')
		const provider = new ScriptedProvider([{ content: 'unreached' }], { failure })

		await expect(provider.generate([], new AbortController().signal)).rejects.toBe(failure)
	})

	it('MalformedAgent generates a result whose typed-string content is a number at runtime', async () => {
		const agent = new MalformedAgent()

		const result = await agent.generate()

		expect(typeof result.content).toBe('number')
		expect(agent.id).toBe('malformed')
	})

	it('MalformedAgent delegates status and emitter to a real wrapped agent', () => {
		const agent = new MalformedAgent()

		expect(agent.status).toBe('idle')
		expect(typeof agent.emitter.on).toBe('function')
	})
})
