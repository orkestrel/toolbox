import { describe, it, expect, afterEach } from 'vitest'
import { createSandboxTool } from '@scsr/server'
import type { SandboxToolInterface } from '@scsr/server'
import { createSandbox } from '@scsr/server'
import type { SandboxInterface } from '@scsr/server'
import { validateSchema } from '../../../../setup.js'

let tool: SandboxToolInterface
let sandboxToClean: SandboxInterface | undefined

afterEach(async () => {
	if (tool) tool.destroy()
	if (sandboxToClean) {
		await sandboxToClean.destroy()
		sandboxToClean = undefined
	}
})

function setup(): SandboxToolInterface {
	tool = createSandboxTool({
		name: 'sandbox',
		summary: 'Test sandbox',
		description: 'Test sandbox tool',
	})
	return tool
}

async function setupWithSandbox(): Promise<{ tool: SandboxToolInterface; id: string }> {
	const t = setup()
	const create = await t.execute({ operation: 'create' })
	const id = (create.output as Record<string, unknown>)['id'] as string
	return { tool: t, id }
}

describe('SandboxTool', () => {
	// === Construction

	describe('construction', () => {
		it('creates with name and description', () => {
			const t = setup()
			expect(t.name).toBe('sandbox')
			expect(t.summary).toBe('Test sandbox')
			expect(t.description).toBe('Test sandbox tool')
		})

		it('exposes valid JSON Schema parameters', () => {
			const t = setup()
			const errors = validateSchema(t.parameters)
			expect(errors).toEqual([])
		})

		it('creates with a pre-existing sandbox', async () => {
			sandboxToClean = await createSandbox()
			tool = createSandboxTool({
				name: 'sandbox',
				summary: 'Test',
				description: 'Test',
				sandbox: sandboxToClean,
			})
			const list = await tool.execute({ operation: 'list' })
			expect(list.ok).toBe(true)
			const output = list.output as Record<string, unknown>
			expect(output['count']).toBe(1)
		})
	})

	// === create

	describe('create', () => {
		it('creates a sandbox and returns an id', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'create' })
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('create')
			const output = result.output as Record<string, unknown>
			expect(typeof output['id']).toBe('string')
			expect(typeof output['root']).toBe('string')
		})

		it('creates a labeled sandbox', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'create', label: 'my-test' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(String(output['root'])).toContain('my-test')
		})

		it('creates multiple sandboxes with unique ids', async () => {
			const t = setup()
			const r1 = await t.execute({ operation: 'create' })
			const r2 = await t.execute({ operation: 'create' })
			const id1 = (r1.output as Record<string, unknown>)['id']
			const id2 = (r2.output as Record<string, unknown>)['id']
			expect(id1).not.toBe(id2)
		})
	})

	// === write / read

	describe('write / read', () => {
		it('writes and reads a file', async () => {
			const { tool: t, id } = await setupWithSandbox()

			const writeResult = await t.execute({
				operation: 'write',
				id,
				path: 'test.txt',
				content: 'hello world',
			})
			expect(writeResult.ok).toBe(true)

			const readResult = await t.execute({ operation: 'read', id, path: 'test.txt' })
			expect(readResult.ok).toBe(true)
			const readOutput = readResult.output as Record<string, unknown>
			expect(readOutput['content']).toBe('hello world')
		})

		it('writes and reads an empty file', async () => {
			const { tool: t, id } = await setupWithSandbox()

			const writeResult = await t.execute({
				operation: 'write',
				id,
				path: 'empty.txt',
				content: '',
			})
			expect(writeResult.ok).toBe(true)

			const hasResult = await t.execute({ operation: 'has', id, path: 'empty.txt' })
			expect(hasResult.ok).toBe(true)
			expect((hasResult.output as Record<string, unknown>)['found']).toBe(true)

			const readResult = await t.execute({ operation: 'read', id, path: 'empty.txt' })
			expect(readResult.ok).toBe(true)
			expect((readResult.output as Record<string, unknown>)['content']).toBe('')
		})

		it('fails without sandbox id', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'write', path: 'f.txt', content: 'x' })
			expect(result.ok).toBe(false)
		})

		it('fails with invalid sandbox id', async () => {
			const t = setup()
			const result = await t.execute({
				operation: 'read',
				id: 'nonexistent',
				path: 'f.txt',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('not found')
		})

		it('overwrites existing file content', async () => {
			const { tool: t, id } = await setupWithSandbox()

			await t.execute({ operation: 'write', id, path: 'f.txt', content: 'first' })
			await t.execute({ operation: 'write', id, path: 'f.txt', content: 'second' })
			const readResult = await t.execute({ operation: 'read', id, path: 'f.txt' })
			expect((readResult.output as Record<string, unknown>)['content']).toBe('second')
		})

		it('fails read for non-existent path', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({ operation: 'read', id, path: 'missing.txt' })
			expect(result.ok).toBe(false)
		})

		it('fails write without path', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({ operation: 'write', id, content: 'x' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('path')
		})

		it('fails write without content', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({ operation: 'write', id, path: 'f.txt' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('content')
		})
	})

	// === ensure

	describe('ensure', () => {
		it('ensures a directory exists (no content)', async () => {
			const { tool: t, id } = await setupWithSandbox()

			const result = await t.execute({ operation: 'ensure', id, path: 'a/b/c' })
			expect(result.ok).toBe(true)

			const stat = await t.execute({ operation: 'stat', id, path: 'a/b/c' })
			expect(stat.ok).toBe(true)
			const statOutput = stat.output as Record<string, unknown>
			expect(statOutput['file']).toBe(false)
		})

		it('ensures a file exists (with content)', async () => {
			const { tool: t, id } = await setupWithSandbox()

			const result = await t.execute({
				operation: 'ensure',
				id,
				path: 'docs/readme.md',
				content: '# Hello',
			})
			expect(result.ok).toBe(true)

			const readResult = await t.execute({ operation: 'read', id, path: 'docs/readme.md' })
			expect((readResult.output as Record<string, unknown>)['content']).toBe('# Hello')
		})

		it('ensure is idempotent for directories', async () => {
			const { tool: t, id } = await setupWithSandbox()
			await t.execute({ operation: 'ensure', id, path: 'x' })
			const r2 = await t.execute({ operation: 'ensure', id, path: 'x' })
			expect(r2.ok).toBe(true)
		})
	})

	// === entries

	describe('entries', () => {
		it('lists directory entries', async () => {
			const { tool: t, id } = await setupWithSandbox()

			await t.execute({ operation: 'write', id, path: 'a.txt', content: 'a' })
			await t.execute({ operation: 'write', id, path: 'b.txt', content: 'b' })

			const result = await t.execute({ operation: 'entries', id, path: '.' })
			expect(result.ok).toBe(true)
			const items = (result.output as Record<string, unknown>)['entries'] as string[]
			const filtered = items.filter((e) => e !== 'node_modules')
			expect(filtered).toContain('a.txt')
			expect(filtered).toContain('b.txt')
		})

		it('defaults to root when path not provided', async () => {
			const { tool: t, id } = await setupWithSandbox()
			await t.execute({ operation: 'write', id, path: 'file.txt', content: 'x' })
			const result = await t.execute({ operation: 'entries', id })
			expect(result.ok).toBe(true)
			const items = (result.output as Record<string, unknown>)['entries'] as string[]
			expect(items.filter((e) => e !== 'node_modules')).toContain('file.txt')
		})
	})

	// === remove

	describe('remove', () => {
		it('removes a file', async () => {
			const { tool: t, id } = await setupWithSandbox()

			await t.execute({ operation: 'write', id, path: 'gone.txt', content: 'x' })
			const result = await t.execute({ operation: 'remove', id, path: 'gone.txt' })
			expect(result.ok).toBe(true)

			const has = await t.execute({ operation: 'has', id, path: 'gone.txt' })
			expect((has.output as Record<string, unknown>)['found']).toBe(false)
		})

		it('removes recursively', async () => {
			const { tool: t, id } = await setupWithSandbox()

			await t.execute({ operation: 'ensure', id, path: 'dir/file.txt', content: 'x' })
			const result = await t.execute({
				operation: 'remove',
				id,
				path: 'dir',
				recursive: true,
			})
			expect(result.ok).toBe(true)
		})

		it('remove with force on non-existent path succeeds', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({
				operation: 'remove',
				id,
				path: 'nope.txt',
				force: true,
			})
			expect(result.ok).toBe(true)
		})
	})

	// === stat

	describe('stat', () => {
		it('returns FileEntry for a file', async () => {
			const { tool: t, id } = await setupWithSandbox()

			await t.execute({ operation: 'write', id, path: 'file.ts', content: 'x' })
			const result = await t.execute({ operation: 'stat', id, path: 'file.ts' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output['file']).toBe(true)
			expect(typeof output['size']).toBe('number')
			expect(typeof output['modified']).toBe('number')
			expect(typeof output['lines']).toBe('number')
		})

		it('fails for missing path', async () => {
			const { tool: t, id } = await setupWithSandbox()

			const result = await t.execute({ operation: 'stat', id, path: 'missing' })
			expect(result.ok).toBe(false)
		})

		it('returns FileEntry for a directory', async () => {
			const { tool: t, id } = await setupWithSandbox()
			await t.execute({ operation: 'ensure', id, path: 'mydir' })
			const result = await t.execute({ operation: 'stat', id, path: 'mydir' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output['file']).toBe(false)
		})
	})

	// === has

	describe('has', () => {
		it('returns true for existing file', async () => {
			const { tool: t, id } = await setupWithSandbox()

			const writeResult = await t.execute({
				operation: 'write',
				id,
				path: 'exists.txt',
				content: '',
			})
			expect(writeResult.ok).toBe(true)
			const result = await t.execute({ operation: 'has', id, path: 'exists.txt' })
			expect(result.ok).toBe(true)
			expect((result.output as Record<string, unknown>)['found']).toBe(true)
		})

		it('returns false for non-existent file', async () => {
			const { tool: t, id } = await setupWithSandbox()

			const result = await t.execute({ operation: 'has', id, path: 'nope.txt' })
			expect(result.ok).toBe(true)
			expect((result.output as Record<string, unknown>)['found']).toBe(false)
		})
	})

	// === execute (process)

	describe('execute (process)', () => {
		it('runs a command and captures stdout', async () => {
			const { tool: t, id } = await setupWithSandbox()
			await t.execute({
				operation: 'write',
				id,
				path: 'hello.js',
				content: 'process.stdout.write("hello")',
			})
			const result = await t.execute({
				operation: 'execute',
				id,
				command: 'node',
				args: ['hello.js'],
			})
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output['stdout']).toBe('hello')
			expect(output['exitCode']).toBe(0)
			expect(output['aborted']).toBe(false)
		})

		it('captures stderr from failing command', async () => {
			const { tool: t, id } = await setupWithSandbox()
			await t.execute({
				operation: 'write',
				id,
				path: 'fail.js',
				content: 'process.stderr.write("oops"); process.exit(1)',
			})
			const result = await t.execute({
				operation: 'execute',
				id,
				command: 'node',
				args: ['fail.js'],
			})
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output['stderr']).toContain('oops')
			expect(output['exitCode']).toBe(1)
		})

		it('passes environment variables', async () => {
			const { tool: t, id } = await setupWithSandbox()
			await t.execute({
				operation: 'write',
				id,
				path: 'env.js',
				content: 'process.stdout.write(process.env.MY_VAR || "")',
			})
			const result = await t.execute({
				operation: 'execute',
				id,
				command: 'node',
				args: ['env.js'],
				environment: { MY_VAR: 'test-value' },
			})
			expect(result.ok).toBe(true)
			expect((result.output as Record<string, unknown>)['stdout']).toBe('test-value')
		})

		it('aborts on timeout', async () => {
			const { tool: t, id } = await setupWithSandbox()
			await t.execute({
				operation: 'write',
				id,
				path: 'hang.js',
				content: 'setTimeout(() => {}, 30000)',
			})
			const result = await t.execute({
				operation: 'execute',
				id,
				command: 'node',
				args: ['hang.js'],
				timeout: 500,
			})
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output['aborted']).toBe(true)
		}, 30_000)

		it('returns error without command', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({ operation: 'execute', id })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('command')
		})

		it('handles empty args array', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({
				operation: 'execute',
				id,
				command: 'echo',
				args: [],
			})
			expect(result.ok).toBe(true)
		})

		it('tracks duration', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({
				operation: 'execute',
				id,
				command: 'echo',
				args: ['hi'],
			})
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(typeof output['duration']).toBe('number')
		})

		it('filters non-string args', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({
				operation: 'execute',
				id,
				command: 'echo',
				args: ['hello', 42, true, 'world'],
			})
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			// Only string args should be kept
			expect(output['args']).toEqual(['hello', 'world'])
		})
	})

	// === destroy

	describe('destroy', () => {
		it('destroys a sandbox', async () => {
			const { tool: t, id } = await setupWithSandbox()

			const result = await t.execute({ operation: 'destroy', id })
			expect(result.ok).toBe(true)
			expect((result.output as Record<string, unknown>)['destroyed']).toBe(true)

			// Sandbox should be removed from the tool
			expect(t.sandbox(id)).toBeUndefined()
		})

		it('fails for unknown sandbox', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'destroy', id: 'nonexistent' })
			expect(result.ok).toBe(false)
		})

		it('list shows reduced count after destroy', async () => {
			const t = setup()
			const r1 = await t.execute({ operation: 'create' })
			await t.execute({ operation: 'create' })
			const id1 = (r1.output as Record<string, unknown>)['id'] as string

			await t.execute({ operation: 'destroy', id: id1 })
			const list = await t.execute({ operation: 'list' })
			expect((list.output as Record<string, unknown>)['count']).toBe(1)
		})
	})

	// === list

	describe('list', () => {
		it('lists all active sandboxes', async () => {
			const t = setup()
			await t.execute({ operation: 'create' })
			await t.execute({ operation: 'create' })

			const result = await t.execute({ operation: 'list' })
			expect(result.ok).toBe(true)
			const output = result.output as Record<string, unknown>
			expect(output['count']).toBe(2)
			const sandboxes = output['sandboxes'] as unknown[]
			expect(sandboxes).toHaveLength(2)
		})

		it('returns empty list when no sandboxes', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'list' })
			expect(result.ok).toBe(true)
			expect((result.output as Record<string, unknown>)['count']).toBe(0)
		})

		it('list entries contain id, root, and destroyed status', async () => {
			const t = setup()
			await t.execute({ operation: 'create' })
			const result = await t.execute({ operation: 'list' })
			const sandboxes = (result.output as Record<string, unknown>)['sandboxes'] as Record<
				string,
				unknown
			>[]
			expect(sandboxes[0]).toHaveProperty('id')
			expect(sandboxes[0]).toHaveProperty('root')
			expect(sandboxes[0]).toHaveProperty('destroyed')
		})
	})

	// === sandbox / sandboxes accessors

	describe('accessors', () => {
		it('sandbox(id) returns a sandbox', async () => {
			const { tool: t, id } = await setupWithSandbox()
			expect(t.sandbox(id)).toBeDefined()
			expect(t.sandbox('bogus')).toBeUndefined()
		})

		it('sandboxes() returns all sandboxes', async () => {
			const t = setup()
			await t.execute({ operation: 'create' })
			await t.execute({ operation: 'create' })

			const all = t.sandboxes()
			expect(all.size).toBe(2)
		})

		it('sandboxes() returns a copy', async () => {
			const t = setup()
			await t.execute({ operation: 'create' })
			const a = t.sandboxes()
			const b = t.sandboxes()
			expect(a).not.toBe(b)
		})
	})

	// === tool destroy

	describe('tool destroy', () => {
		it('destroys all sandboxes', async () => {
			const t = setup()
			await t.execute({ operation: 'create' })
			await t.execute({ operation: 'create' })
			expect(t.sandboxes().size).toBe(2)

			t.destroy()
			expect(t.sandboxes().size).toBe(0)
		})

		it('is safe to call destroy on empty tool', () => {
			const t = setup()
			t.destroy()
			expect(t.sandboxes().size).toBe(0)
		})
	})

	// === error handling

	describe('error handling', () => {
		it('returns error for unknown operation', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'bogus' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Unknown operation')
		})

		it('returns error for missing operation', async () => {
			const t = setup()
			const result = await t.execute({})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Missing or invalid operation')
		})

		it('records duration on failure', async () => {
			const t = setup()
			const result = await t.execute({ operation: 'read', id: 'nope', path: 'x' })
			expect(result.ok).toBe(false)
			expect(result.duration).toBeGreaterThanOrEqual(0)
		})

		it('guards against path escape', async () => {
			const { tool: t, id } = await setupWithSandbox()

			const result = await t.execute({
				operation: 'write',
				id,
				path: '../../escape.txt',
				content: 'bad',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('escapes')
		})

		it('guards against path escape on read', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({
				operation: 'read',
				id,
				path: '../../package.json',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('escapes')
		})

		it('guards against path escape on ensure', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({
				operation: 'ensure',
				id,
				path: '../../escape',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('escapes')
		})

		it('guards against path escape on remove', async () => {
			const { tool: t, id } = await setupWithSandbox()
			const result = await t.execute({
				operation: 'remove',
				id,
				path: '../../important',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('escapes')
		})

		it('returns error for numeric operation value', async () => {
			const t = setup()
			const result = await t.execute({ operation: 42 })
			expect(result.ok).toBe(false)
		})
	})
})
