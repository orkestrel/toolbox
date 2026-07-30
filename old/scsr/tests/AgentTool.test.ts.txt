/**
 * AgentTool Tests
 *
 * Tests for the AgentTool MCP wrapper.
 * Uses a real Ollama server — skips when unavailable.
 */

import { describe, expect, it } from 'vitest'
import { AgentTool, isRecord } from '@scsr/core'
import {
	isOllamaAvailable,
	OLLAMA_CONFIG,
	createTestManager,
	toArray,
	toRecord,
} from '../../../../setup.js'

const available = await isOllamaAvailable()

function expectRecord(value: unknown): Record<string, unknown> {
	expect(isRecord(value)).toBe(true)
	return toRecord(value)
}

function createTool(): AgentTool {
	return new AgentTool({
		name: 'agent',
		summary: 's',
		description: 'd',
		manager: createTestManager(),
		url: OLLAMA_CONFIG.host,
	})
}

describe('AgentTool', () => {
	it('has name, summary, description, and parameters', () => {
		const tool = new AgentTool({
			name: 'test-agent',
			summary: 'A test agent',
			description: 'Test agent tool',
			manager: createTestManager(),
		})
		expect(tool.name).toBe('test-agent')
		expect(tool.summary).toBe('A test agent')
		expect(tool.description).toBe('Test agent tool')
		expect(tool.parameters).toBeDefined()
		expect(typeof tool.parameters).toBe('object')
	})

	it('exposes parameters with all supported fields', () => {
		const tool = createTool()
		const properties = expectRecord(tool.parameters.properties)
		expect(properties['task']).toBeDefined()
		expect(properties['model']).toBeDefined()
		expect(properties['models']).toBeDefined()
		expect(properties['system']).toBeDefined()
		expect(properties['instructions']).toBeDefined()
		expect(properties['documents']).toBeDefined()
		expect(properties['images']).toBeDefined()
		expect(properties['tools']).toBeDefined()
		expect(properties['messages']).toBeDefined()
		expect(properties['scope']).toBeDefined()
		expect(properties['timeout']).toBeDefined()
		expect(properties['budget']).toBeDefined()
		const scope = expectRecord(properties['scope'])
		const scopeProperties = expectRecord(scope['properties'])
		expect(scopeProperties['tools']).toBeDefined()
	})

	it('exposes the agent manager', () => {
		const manager = createTestManager()
		const tool = new AgentTool({
			name: 'agent',
			summary: 's',
			description: 'd',
			manager,
		})
		expect(tool.manager).toBe(manager)
	})

	describe.skipIf(!available)('with Ollama', () => {
		it('returns an error when task is missing', async () => {
			const result = expectRecord(await createTool().execute({}))
			expect(result.error).toBeDefined()
		})

		it('returns an error when task is empty', async () => {
			const result = expectRecord(await createTool().execute({ task: '' }))
			expect(result.error).toBeDefined()
		})

		it('generates a response for a valid task', async () => {
			const result = expectRecord(await createTool().execute({ task: 'Reply hello.' }))
			expect(result.response).toBeDefined()
			expect(typeof result.response).toBe('string')
		})

		it('accepts an optional system prompt', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Sky color? One word.',
					system: 'One word only.',
				}),
			)
			expect(result.response).toBeDefined()
		})

		it('accepts instructions for the sub-agent', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: '2+2?',
					instructions: [{ name: 'format', content: 'Reply with one word.' }],
				}),
			)
			expect(result.response).toBeDefined()
			expect(typeof result.response).toBe('string')
		})

		it('accepts documents as context for the sub-agent', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Project name? One word.',
					documents: [{ path: 'config.json', content: '{"name": "orkestrel"}', language: 'json' }],
				}),
			)
			expect(result.response).toBeDefined()
			expect(typeof result.response).toBe('string')
		})

		it('accepts images for multimodal inference', async () => {
			const pixel =
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=='
			const result = expectRecord(
				await createTool().execute({
					task: 'Pixel color? One word.',
					images: [{ name: 'pixel.png', data: pixel, mime: 'image/png' }],
				}),
			)
			const gotResponse = typeof result.response === 'string'
			const gotError = typeof result.error === 'string'
			expect(gotResponse || gotError).toBe(true)
		})

		it('accepts conversation messages for prior context', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Previous topic? Short answer.',
					messages: [
						{ role: 'user', content: 'TypeScript generics?' },
						{ role: 'assistant', content: 'Reusable typed code.' },
					],
				}),
			)
			expect(result.response).toBeDefined()
			expect(typeof result.response).toBe('string')
		})

		it('accepts a scope to restrict instructions, documents, images, and messages', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					instructions: [
						{ name: 'visible', content: 'Be concise.' },
						{ name: 'hidden', content: 'Be verbose.' },
					],
					scope: {
						instructions: ['visible'],
					},
				}),
			)
			expect(result.response).toBeDefined()
			expect(typeof result.response).toBe('string')
		})

		it('accepts a timeout for sub-agent execution', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					timeout: 30_000,
				}),
			)
			expect(result.response).toBeDefined()
			expect(typeof result.response).toBe('string')
		})

		it('accepts a budget for sub-agent token limiting', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					budget: { max: 10_000 },
				}),
			)
			expect(result.response).toBeDefined()
			expect(typeof result.response).toBe('string')
		})

		it('accepts a total-scope budget for sub-agent token limiting', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					budget: { max: 10_000, scope: 'total' },
				}),
			)
			expect(result.response).toBeDefined()
			expect(typeof result.response).toBe('string')
		})

		it('ignores invalid instruction entries', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					instructions: [
						{ name: '', content: 'ignored' },
						{ name: 'valid', content: '' },
						42,
						null,
					],
				}),
			)
			expect(result.response).toBeDefined()
		})

		it('ignores invalid document entries', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					documents: [
						{ path: '', content: 'ignored' },
						{ path: 'valid', content: '' },
						'not-an-object',
					],
				}),
			)
			expect(result.response).toBeDefined()
		})

		it('ignores non-array instructions and documents gracefully', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					instructions: 'not-an-array',
					documents: 42,
					tools: 'not-an-array',
				}),
			)
			expect(result.response).toBeDefined()
		})

		it('ignores invalid message entries', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					messages: [
						{ role: 'system', content: 'ignored — system role not allowed' },
						{ role: 'user', content: '' },
						{ role: '', content: 'ignored — empty role' },
						42,
						null,
					],
				}),
			)
			expect(result.response).toBeDefined()
		})

		it('ignores invalid scope values gracefully', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					scope: 'not-an-object',
				}),
			)
			expect(result.response).toBeDefined()
		})

		it('ignores invalid budget values gracefully', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					budget: { max: -1 },
				}),
			)
			expect(result.response).toBeDefined()
		})

		it('ignores invalid timeout values gracefully', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					timeout: -100,
				}),
			)
			expect(result.response).toBeDefined()
		})

		it('lists available models from the provider', async () => {
			const result = expectRecord(await createTool().execute({ models: true }))
			expect(result.models).toBeDefined()
			expect(Array.isArray(result.models)).toBe(true)
			const models = toArray(result.models)
			expect(models.length).toBeGreaterThan(0)
			const first = expectRecord(models[0])
			expect(typeof first['name']).toBe('string')
		})

		it('generates a response with a model override', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply model override works.',
					model: OLLAMA_CONFIG.model,
				}),
			)
			expect(result.response).toBeDefined()
			expect(typeof result.response).toBe('string')
		})

		it('ignores empty model string and uses default', async () => {
			const result = expectRecord(
				await createTool().execute({
					task: 'Reply ok.',
					model: '',
				}),
			)
			expect(result.response).toBeDefined()
		})
	})
})
