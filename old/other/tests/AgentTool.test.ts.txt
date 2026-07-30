/**
 * AgentTool Tests
 *
 * Tests for the AgentTool MCP wrapper.
 * Uses a real Ollama server — skips when unavailable.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { AgentTool } from '@orkestrel/mcp'
import { isRecord } from '@orkestrel/core'
import { isOllamaAvailable, OLLAMA_CONFIG } from '../../setup.js'
import { createTestManager, toRecord } from '../../setupServer.js'

let available = false

beforeAll(async () => {
	available = await isOllamaAvailable()
})

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
		const properties = expectRecord(tool.parameters['properties'])
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

	it('returns an error when task is missing', async () => {
		if (!available) return
		const result = expectRecord(await createTool().execute({}))
		expect(result.error).toBeDefined()
	})

	it('returns an error when task is empty', async () => {
		if (!available) return
		const result = expectRecord(await createTool().execute({ task: '' }))
		expect(result.error).toBeDefined()
	})

	it('generates a response for a valid task', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "hello" and nothing else.',
			}),
		)
		expect(result.response).toBeDefined()
		expect(typeof result.response).toBe('string')
	})

	it('accepts an optional system prompt', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'What color is the sky on a clear day? Reply with just the color.',
				system: 'You answer in one word only.',
			}),
		)
		expect(result.response).toBeDefined()
	})

	it('accepts instructions for the sub-agent', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'What is 2+2?',
				instructions: [{ name: 'format', content: 'Always respond in exactly one word.' }],
			}),
		)
		expect(result.response).toBeDefined()
		expect(typeof result.response).toBe('string')
	})

	it('accepts documents as context for the sub-agent', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'What is the project name defined in the config?',
				documents: [{ path: 'config.json', content: '{"name": "orkestrel"}', language: 'json' }],
			}),
		)
		expect(result.response).toBeDefined()
		expect(typeof result.response).toBe('string')
	})

	it('accepts images for multimodal inference', async () => {
		if (!available) return
		// Minimal 1x1 red PNG (valid base64)
		const pixel =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=='
		const result = expectRecord(
			await createTool().execute({
				task: 'What color is this pixel? Reply with one word.',
				images: [{ name: 'pixel.png', data: pixel, mime: 'image/png' }],
			}),
		)
		// The plumbing worked — either we got a response or a gracefully handled error
		const gotResponse = typeof result.response === 'string'
		const gotError = typeof result.error === 'string'
		expect(gotResponse || gotError).toBe(true)
	})

	it('accepts conversation messages for prior context', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'What was my previous question about?',
				messages: [
					{ role: 'user', content: 'Tell me about TypeScript generics.' },
					{ role: 'assistant', content: 'TypeScript generics allow you to write reusable code.' },
				],
			}),
		)
		expect(result.response).toBeDefined()
		expect(typeof result.response).toBe('string')
	})

	it('accepts a scope to restrict instructions, documents, images, and messages', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
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
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
				timeout: 30_000,
			}),
		)
		expect(result.response).toBeDefined()
		expect(typeof result.response).toBe('string')
	})

	it('accepts a budget for sub-agent token limiting', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
				budget: { max: 10_000 },
			}),
		)
		expect(result.response).toBeDefined()
		expect(typeof result.response).toBe('string')
	})

	it('ignores invalid instruction entries', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
				instructions: [{ name: '', content: 'ignored' }, { name: 'valid', content: '' }, 42, null],
			}),
		)
		expect(result.response).toBeDefined()
	})

	it('ignores invalid document entries', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
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
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
				instructions: 'not-an-array',
				documents: 42,
				tools: 'not-an-array',
			}),
		)
		expect(result.response).toBeDefined()
	})

	it('ignores invalid message entries', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
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
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
				scope: 'not-an-object',
			}),
		)
		expect(result.response).toBeDefined()
	})

	it('ignores invalid budget values gracefully', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
				budget: { max: -1 },
			}),
		)
		expect(result.response).toBeDefined()
	})

	it('ignores invalid timeout values gracefully', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
				timeout: -100,
			}),
		)
		expect(result.response).toBeDefined()
	})

	it('lists available models from the provider', async () => {
		if (!available) return
		const result = expectRecord(await createTool().execute({ models: true }))
		expect(result.models).toBeDefined()
		expect(Array.isArray(result.models)).toBe(true)
		const models = result.models as { name: string; size: number; modified: string }[]
		expect(models.length).toBeGreaterThan(0)
		expect(typeof models[0].name).toBe('string')
	})

	it('generates a response with a model override', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "model override works" and nothing else.',
				model: OLLAMA_CONFIG.model,
			}),
		)
		expect(result.response).toBeDefined()
		expect(typeof result.response).toBe('string')
	})

	it('ignores empty model string and uses default', async () => {
		if (!available) return
		const result = expectRecord(
			await createTool().execute({
				task: 'Say "ok".',
				model: '',
			}),
		)
		expect(result.response).toBeDefined()
	})
})
