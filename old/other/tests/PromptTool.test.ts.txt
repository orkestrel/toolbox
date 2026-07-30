import { describe, it, expect, afterEach } from 'vitest'
import type { PromptToolInterface } from '@orkestrel/mcp'
import { PromptTool, createMCPStoreManager } from '@orkestrel/mcp'
import type { TestDir } from '../../setupServer.js'
import {
	createTestDir,
	destroyTestDir,
	createTestTerminal,
	validateSchema,
	writeJson,
	greetingTemplate,
	fullTemplate,
} from '../../setupServer.js'
import { PassThrough } from 'node:stream'

let tool: PromptToolInterface
let testDir: TestDir | undefined

afterEach(async () => {
	if (testDir) {
		await destroyTestDir(testDir)
		testDir = undefined
	}
})

function setup(): PromptToolInterface {
	const { terminal } = createTestTerminal()
	tool = new PromptTool({
		name: 'prompt',
		summary: 'Test prompt',
		description: 'Test prompt tool',
		terminal: terminal,
	})
	return tool
}

function setupWithInput(): { tool: PromptToolInterface; input: PassThrough } {
	const { terminal, input } = createTestTerminal()
	tool = new PromptTool({
		name: 'prompt',
		summary: 'Test prompt',
		description: 'Test prompt tool',
		terminal: terminal,
	})
	return { tool, input }
}

const sampleTemplate = greetingTemplate()

describe('PromptTool', () => {
	// === Construction

	describe('construction', () => {
		it('creates with name, summary, and description', () => {
			const t = setup()
			expect(t.name).toBe('prompt')
			expect(t.summary).toBe('Test prompt')
			expect(t.description).toBe('Test prompt tool')
		})

		it('exposes valid JSON Schema parameters', () => {
			const t = setup()
			const errors = validateSchema(t.parameters)
			expect(errors).toEqual([])
		})

		it('starts with no templates', () => {
			const t = setup()
			expect(t.templates()).toEqual([])
		})

		it('stores getter returns undefined when no stores configured', () => {
			const t = setup()
			expect(t.stores).toBeUndefined()
		})
	})

	// === Template Management

	describe('template management', () => {
		it('registers a template via execute', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'register', template: sampleTemplate })
			expect(result.ok).toBe(true)
			expect(t.template('greeting')).toBeDefined()
		})

		it('lists registered templates via execute', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({ operation: 'templates' })
			expect(result.ok).toBe(true)
			const output = result.output as unknown[]
			expect(output.length).toBe(1)
		})

		it('fills a template via execute', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({
				operation: 'fill',
				id: 'greeting',
				values: { name: 'Alice' },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('Hello, Alice! Welcome to the system.')
		})

		it('validates a template via execute', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({
				operation: 'validate',
				id: 'greeting',
				values: { name: 'Alice' },
			})
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.valid).toBe(true)
		})

		it('removes a template via execute', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({ operation: 'remove', id: 'greeting' })
			expect(result.ok).toBe(true)
			expect(t.template('greeting')).toBeUndefined()
		})

		it('returns error for unknown operation', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'unknown' })
			expect(result.ok).toBe(false)
		})

		it('returns error for missing operation', async () => {
			const t = setup()
			const result = await t.execute({})
			expect(result.ok).toBe(false)
		})

		it('registers template with all optional fields', async () => {
			const t = setup()
			const full = fullTemplate()
			const result = await t.execute({ operation: 'register', template: full })
			expect(result.ok).toBe(true)
			expect(t.template('full')).toBeDefined()
			const stored = t.template('full')
			expect(stored?.summary).toBe('A full email template')
			expect(stored?.category).toBe('communication')
			expect(stored?.tags).toContain('email')
		})

		it('lists multiple templates', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			await t.execute({ operation: 'register', template: fullTemplate() })
			const result = await t.execute({ operation: 'templates' })
			expect(result.ok).toBe(true)
			const output = result.output as unknown[]
			expect(output.length).toBe(2)
		})

		it('templates listing includes placeholder names', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({ operation: 'templates' })
			const output = result.output as Record<string, unknown>[]
			const first = output[0]
			expect(first).toBeDefined()
			const placeholders = first['placeholders'] as string[]
			expect(placeholders).toContain('name')
			expect(placeholders).toContain('place')
		})

		it('validates with missing required placeholders', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({
				operation: 'validate',
				id: 'greeting',
				values: {},
			})
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.valid).toBe(false)
			const missing = output.missing as string[]
			expect(missing).toContain('name')
		})

		it('validates with extra values', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({
				operation: 'validate',
				id: 'greeting',
				values: { name: 'Alice', extra: 'ignored' },
			})
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.valid).toBe(true)
			const extra = output.extra as string[]
			expect(extra).toContain('extra')
		})

		it('fill returns error for missing required values', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({
				operation: 'fill',
				id: 'greeting',
				values: {},
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Missing required placeholders')
		})

		it('fill with non-string values filters them out', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({
				operation: 'fill',
				id: 'greeting',
				values: { name: 'Alice', place: 42 },
			})
			// place is non-string so filtered out, default used
			expect(result.ok).toBe(true)
			expect(result.output).toBe('Hello, Alice! Welcome to the system.')
		})

		it('fill with no values object uses empty record', async () => {
			const t = setup()
			const full = fullTemplate()
			await t.execute({ operation: 'register', template: full })
			const result = await t.execute({
				operation: 'fill',
				id: 'full',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Missing required placeholders')
		})

		it('remove returns success for non-existent template', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'remove', id: 'nonexistent' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.removed).toBe(false)
		})

		it('replaces existing template on re-register', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			await t.execute({
				operation: 'register',
				template: { ...sampleTemplate, name: 'Updated' },
			})
			expect(t.template('greeting')?.name).toBe('Updated')
			expect(t.templates().length).toBe(1)
		})
	})

	// === Prompt Operations

	describe('prompt operations', () => {
		it('handles input operation', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('Alice\n'))
			const result = await t.execute({ operation: 'input', message: 'Name' })
			expect(result.ok).toBe(true)
			expect(result.output).toBe('Alice')
			expect(result.operation).toBe('input')
		})

		it('handles input with default value', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Name',
				default: 'World',
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('World')
		})

		it('returns error for input without message', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'input' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('message')
		})

		it('handles password operation', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('secret\n'))
			const result = await t.execute({ operation: 'password', message: 'Password' })
			expect(result.ok).toBe(true)
			expect(result.output).toBe('secret')
			expect(result.operation).toBe('password')
		})

		it('returns error for password without message', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'password' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('message')
		})

		it('handles confirm operation (yes)', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('y\n'))
			const result = await t.execute({ operation: 'confirm', message: 'Continue?' })
			expect(result.ok).toBe(true)
			expect(result.output).toBe(true)
			expect(result.operation).toBe('confirm')
		})

		it('handles confirm operation (no)', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('n\n'))
			const result = await t.execute({ operation: 'confirm', message: 'Continue?' })
			expect(result.ok).toBe(true)
			expect(result.output).toBe(false)
		})

		it('handles confirm with default boolean', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('\n'))
			const result = await t.execute({
				operation: 'confirm',
				message: 'Continue?',
				default: true,
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe(true)
		})

		it('returns error for confirm without message', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'confirm' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('message')
		})

		it('handles select operation', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('2\n'))
			const result = await t.execute({
				operation: 'select',
				message: 'Pick',
				choices: ['alpha', 'beta', 'gamma'],
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('beta')
			expect(result.operation).toBe('select')
		})

		it('handles select with object choices', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('1\n'))
			const result = await t.execute({
				operation: 'select',
				message: 'Pick',
				choices: [
					{ name: 'Option A', value: 'a', description: 'First' },
					{ name: 'Option B', value: 'b' },
				],
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('a')
		})

		it('returns error for select without message', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'select', choices: ['a'] })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('message')
		})

		it('returns error for select without choices', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'select', message: 'Pick' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('choices')
		})

		it('returns error for select with empty choices', async () => {
			const t = setup()
			const result = await t.execute({
				operation: 'select',
				message: 'Pick',
				choices: [],
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('choices')
		})

		it('handles checkbox operation', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('1,3\n'))
			const result = await t.execute({
				operation: 'checkbox',
				message: 'Select',
				choices: ['alpha', 'beta', 'gamma'],
			})
			expect(result.ok).toBe(true)
			const output = result.output as readonly string[]
			expect(output).toEqual(['alpha', 'gamma'])
			expect(result.operation).toBe('checkbox')
		})

		it('returns error for checkbox without message', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'checkbox', choices: ['a'] })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('message')
		})

		it('returns error for checkbox without choices', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'checkbox', message: 'Select' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('choices')
		})

		it('handles editor operation', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('Some content\n'))
			const result = await t.execute({ operation: 'editor', message: 'Enter' })
			expect(result.ok).toBe(true)
			expect(result.output).toBe('Some content')
			expect(result.operation).toBe('editor')
		})

		it('handles editor with default value', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('\n'))
			const result = await t.execute({
				operation: 'editor',
				message: 'Enter',
				default: 'fallback',
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('fallback')
		})

		it('returns error for editor without message', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'editor' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('message')
		})

		it('handles form operation with multiple fields', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => {
				input.write('Alice\n')
				setTimeout(() => input.write('y\n'), 10)
			})
			const result = await t.execute({
				operation: 'form',
				fields: [
					{ name: 'name', type: 'input', message: 'Name' },
					{ name: 'confirmed', type: 'confirm', message: 'OK?' },
				],
			})
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('form')
			const output = result.output as Record<string, unknown>
			expect(output.name).toBe('Alice')
			expect(output.confirmed).toBe(true)
		})

		it('handles form with defaults', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => {
				input.write('\n')
				setTimeout(() => input.write('\n'), 10)
			})
			const result = await t.execute({
				operation: 'form',
				fields: [
					{ name: 'name', type: 'input', message: 'Name', default: 'Bob' },
					{ name: 'confirmed', type: 'confirm', message: 'OK?', default: true },
				],
			})
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.name).toBe('Bob')
			expect(output.confirmed).toBe(true)
		})

		it('returns error for form without fields', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'form' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('fields')
		})

		it('returns error for form with empty fields array', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'form', fields: [] })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('fields')
		})

		it('returns error for form field missing name', async () => {
			const t = setup()
			const result = await t.execute({
				operation: 'form',
				fields: [{ type: 'input', message: 'Name' }],
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('name')
		})

		it('returns error for form field with invalid type', async () => {
			const t = setup()
			const result = await t.execute({
				operation: 'form',
				fields: [{ name: 'x', type: 'bogus', message: 'X' }],
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('bogus')
		})
	})

	// === Validation Rules via MCP

	describe('validation rules', () => {
		it('validates input with required rule', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Name',
				validate: { required: true },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
			const output = result.output as Record<string, unknown>
			expect(output.valid).toBe(false)
			const errors = output.errors as { rule: string; message: string }[]
			expect(errors.some((e) => e.rule === 'required')).toBe(true)
		})

		it('validates input with minimum rule', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('ab\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Name',
				validate: { minimum: 3 },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
		})

		it('passes input when minimum rule is satisfied', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('abc\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Name',
				validate: { minimum: 3 },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('abc')
		})

		it('validates input with maximum rule', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('abcdef\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Name',
				validate: { maximum: 5 },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('')
		})

		it('validates input with pattern rule', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('Hello!\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Code',
				validate: { pattern: '^[a-z]+$' },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
		})

		it('passes input when pattern matches', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('hello\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Code',
				validate: { pattern: '^[a-z]+$' },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('hello')
		})

		it('composes required + minimum + pattern rules', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Name',
				validate: { required: true, minimum: 3, pattern: '^[a-z]+$' },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
			// All three rules fail on empty input
			const output = result.output as Record<string, unknown>
			const errors = output.errors as { rule: string; message: string }[]
			expect(errors.length).toBeGreaterThanOrEqual(1)
		})

		it('validates password with rules', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('ab\n'))
			const result = await t.execute({
				operation: 'password',
				message: 'Password',
				validate: { minimum: 8 },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
		})

		it('validates editor with rules', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('\n'))
			const result = await t.execute({
				operation: 'editor',
				message: 'Content',
				validate: { required: true },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
		})

		it('ignores non-object validate argument', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('hello\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Name',
				validate: 'not-an-object',
			})
			expect(result.ok).toBe(true)
			// no validation applied, accepts input
			expect(result.output).toBe('hello')
		})

		it('ignores validate with no recognized keys', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('anything\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Name',
				validate: { unknownKey: true },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('anything')
		})

		it('validates input with email rule', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('not-an-email\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Email',
				validate: { email: true },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
			const output = result.output as Record<string, unknown>
			const errors = output.errors as { rule: string; message: string }[]
			expect(errors.some((e) => e.rule === 'email')).toBe(true)
		})

		it('passes input when email rule is satisfied', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('user@example.com\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Email',
				validate: { email: true },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('user@example.com')
		})

		it('validates input with url rule', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('not-a-url\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'URL',
				validate: { url: true },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
		})

		it('passes input when url rule is satisfied', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('https://example.com\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'URL',
				validate: { url: true },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('https://example.com')
		})

		it('validates input with numeric rule', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('abc\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Amount',
				validate: { numeric: true },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
		})

		it('passes input when numeric rule is satisfied', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('42.5\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Amount',
				validate: { numeric: true },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('42.5')
		})

		it('validates input with integer rule', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('3.14\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Count',
				validate: { integer: true },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
		})

		it('passes input when integer rule is satisfied', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('42\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Count',
				validate: { integer: true },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('42')
		})

		it('validates input with alphanumeric rule', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('hello world!\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Code',
				validate: { alphanumeric: true },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Validation failed')
		})

		it('passes input when alphanumeric rule is satisfied', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('abc123\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Code',
				validate: { alphanumeric: true },
			})
			expect(result.ok).toBe(true)
			expect(result.output).toBe('abc123')
		})

		it('returns structured validation errors with rule names', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Email',
				validate: { required: true, email: true },
			})
			expect(result.ok).toBe(false)
			expect(result.operation).toBe('input')
			const output = result.output as Record<string, unknown>
			expect(output.valid).toBe(false)
			const errors = output.errors as { rule: string; message: string }[]
			expect(errors.length).toBeGreaterThanOrEqual(2)
			const ruleNames = errors.map((e) => e.rule)
			expect(ruleNames).toContain('required')
			expect(ruleNames).toContain('email')
		})

		it('validation error includes human-readable summary', async () => {
			const { tool: t, input } = setupWithInput()
			process.nextTick(() => input.write('\n'))
			const result = await t.execute({
				operation: 'input',
				message: 'Name',
				validate: { required: true },
			})
			expect(result.ok).toBe(false)
			expect(result.error).toMatch(/^Validation failed: /)
			expect(result.error).toContain('required')
		})
	})

	// === Duration Tracking

	describe('duration tracking', () => {
		it('records duration on success', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const result = await t.execute({ operation: 'templates' })
			expect(result.duration).toBeGreaterThanOrEqual(0)
		})

		it('records duration on failure', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'unknown' })
			expect(result.duration).toBeGreaterThanOrEqual(0)
		})
	})

	// === Forget

	describe('forget', () => {
		it('removes one template by id', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			const removed = t.forget('greeting')
			expect(removed).toBe(true)
			expect(t.template('greeting')).toBeUndefined()
		})

		it('returns false for non-existent id', () => {
			const t = setup()
			expect(t.forget('missing')).toBe(false)
		})

		it('removes all templates', async () => {
			const t = setup()
			await t.execute({ operation: 'register', template: sampleTemplate })
			await t.execute({ operation: 'register', template: fullTemplate() })
			t.forget()
			expect(t.templates()).toEqual([])
		})
	})

	// === Init

	describe('init', () => {
		it('init without stores is a no-op', async () => {
			const t = setup()
			await t.init()
			expect(t.templates()).toEqual([])
		})
	})

	// === Init with Stores

	describe('init with stores', () => {
		it('loads templates from stores on init', async () => {
			testDir = await createTestDir()
			writeJson(testDir.root, 'greeting.json', sampleTemplate)

			const stores = createMCPStoreManager()
			stores.create({ path: testDir.root })

			const { terminal } = createTestTerminal()
			tool = new PromptTool({
				name: 'prompt',
				summary: 'Test',
				description: 'Test',
				terminal: terminal,
				stores,
			})
			await tool.init()
			expect(tool.template('greeting')).toBeDefined()
			expect(tool.stores).toBeDefined()
		})

		it('persists templates to stores on register', async () => {
			testDir = await createTestDir()
			const stores = createMCPStoreManager()
			stores.create({ path: testDir.root })

			const { terminal } = createTestTerminal()
			tool = new PromptTool({
				name: 'prompt',
				summary: 'Test',
				description: 'Test',
				terminal: terminal,
				stores,
			})
			await tool.execute({ operation: 'register', template: sampleTemplate })

			// Verify stored
			const entry = stores.entry('greeting')
			expect(entry).toBeDefined()
		})
	})

	// === Error Cases

	describe('error cases', () => {
		it('returns error for register with invalid template', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'register', template: { id: 'x' } })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('template')
		})

		it('returns error for register with null template', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'register', template: null })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('template')
		})

		it('returns error for register with no template field', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'register' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('template')
		})

		it('returns error for fill with missing id', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'fill' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('id')
		})

		it('returns error for fill with non-existent template', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'fill', id: 'nonexistent', values: {} })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('not found')
		})

		it('returns error for validate with missing id', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'validate' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('id')
		})

		it('returns error for validate with non-existent template', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'validate', id: 'nonexistent' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('not found')
		})

		it('returns error for remove with missing id', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'remove' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('id')
		})
	})

	// === Launch Operation

	describe('launch operation', () => {
		it('returns error when remote is not configured', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'launch' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('not configured')
			expect(result.operation).toBe('launch')
		})

		it('launches companion when not connected', async () => {
			const { terminal } = createTestTerminal()
			let launched = false
			tool = new PromptTool({
				name: 'prompt',
				summary: 'Test',
				description: 'Test',
				terminal: terminal,
				remote: {
					port: 3001,
					token: 'test-token',
					script: '/path/to/prompt.js',
					connected: () => launched,
					launch: () => {
						launched = true
						return true
					},
				},
			})
			const result = await tool.execute({ operation: 'launch' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.launched).toBe(true)
			expect(output.connected).toBe(true)
		})

		it('does not launch when already connected', async () => {
			const { terminal } = createTestTerminal()
			let launchCount = 0
			tool = new PromptTool({
				name: 'prompt',
				summary: 'Test',
				description: 'Test',
				terminal: terminal,
				remote: {
					port: 3001,
					token: 'test-token',
					script: '/path/to/prompt.js',
					connected: () => true,
					launch: () => {
						launchCount++
						return true
					},
				},
			})
			const result = await tool.execute({ operation: 'launch' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.launched).toBe(false)
			expect(output.connected).toBe(true)
			expect(output.reason).toContain('already connected')
			expect(launchCount).toBe(0)
		})

		it('reports failure when launch returns false', async () => {
			const { terminal } = createTestTerminal()
			tool = new PromptTool({
				name: 'prompt',
				summary: 'Test',
				description: 'Test',
				terminal: terminal,
				remote: {
					port: 3001,
					token: 'test-token',
					script: '/path/to/prompt.js',
					connected: () => false,
					launch: () => false,
				},
			})
			const result = await tool.execute({ operation: 'launch' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.launched).toBe(false)
			expect(output.reason).toContain('Failed')
		})

		it('records duration for launch', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'launch' })
			expect(result.duration).toBeGreaterThanOrEqual(0)
		})
	})

	// === Status Operation

	describe('status operation', () => {
		it('returns local status when remote is not configured', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'status' })
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('status')
			const output = result.output as Record<string, unknown>
			expect(output.remote).toBe(false)
			expect(output.connected).toBe(false)
			expect(output.message).toContain('not configured')
		})

		it('returns connected status when companion is connected', async () => {
			const { terminal } = createTestTerminal()
			tool = new PromptTool({
				name: 'prompt',
				summary: 'Test',
				description: 'Test',
				terminal: terminal,
				remote: {
					port: 3001,
					token: 'test-token',
					script: '/path/to/prompt.js',
					connected: () => true,
					launch: () => true,
				},
			})
			const result = await tool.execute({ operation: 'status' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.remote).toBe(true)
			expect(output.connected).toBe(true)
			expect(output.port).toBe(3001)
			expect(output.command).toContain('--port 3001')
			expect(output.command).toContain('--token test-token')
			expect(output.message).toContain('connected and ready')
		})

		it('returns disconnected status when companion is not connected', async () => {
			const { terminal } = createTestTerminal()
			tool = new PromptTool({
				name: 'prompt',
				summary: 'Test',
				description: 'Test',
				terminal: terminal,
				remote: {
					port: 3002,
					token: 'abc123',
					script: '/path/to/prompt.js',
					connected: () => false,
					launch: () => true,
				},
			})
			const result = await tool.execute({ operation: 'status' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output.remote).toBe(true)
			expect(output.connected).toBe(false)
			expect(output.message).toContain('not connected')
		})

		it('records duration for status', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'status' })
			expect(result.duration).toBeGreaterThanOrEqual(0)
		})
	})
})
