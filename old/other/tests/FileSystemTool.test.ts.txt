import { describe, it, expect, afterEach } from 'vitest'
import { FileSystemTool, createMCPStoreManager } from '@orkestrel/mcp'
import { createFileSystem, FileSystemInterface } from '@orkestrel/filesystem'
import type { FileSystemToolResult } from '@orkestrel/mcp'
import type { TestDir } from '../../setupServer.js'
import {
	createTestDir,
	destroyTestDir,
	readFromDisk,
	existsOnDisk,
	validateSchema,
} from '../../setupServer.js'

let testDir: TestDir | undefined
let filesystem: FileSystemInterface
let tool: FileSystemTool

function requireTestDir(): TestDir {
	if (testDir === undefined) throw new Error('testDir not initialized — call setup() first')
	return testDir
}

async function setup(files: Record<string, string>): Promise<void> {
	testDir = await createTestDir(files)
	filesystem = createFileSystem({ root: testDir.root })
	tool = new FileSystemTool({
		name: 'fs',
		summary: 'Test fs',
		description: 'test filesystem tool',
		filesystem,
	})
}

afterEach(async () => {
	if (filesystem) filesystem.destroy()
	if (testDir) await destroyTestDir(testDir)
	testDir = undefined
})

/** Shortcut to execute and assert ok */
async function execOk(args: Record<string, unknown>): Promise<FileSystemToolResult> {
	const result = await tool.execute(args)
	expect(result.ok).toBe(true)
	return result
}

/** Shortcut to execute and assert failure */
async function execFail(args: Record<string, unknown>): Promise<FileSystemToolResult> {
	const result = await tool.execute(args)
	expect(result.ok).toBe(false)
	return result
}

describe('FileSystemTool', () => {
	// === Properties

	describe('properties', () => {
		it('exposes name, summary, description, parameters', async () => {
			await setup({})
			expect(tool.name).toBe('fs')
			expect(tool.summary).toBe('Test fs')
			expect(tool.description).toBe('test filesystem tool')
			expect(tool.parameters).toBeDefined()
			expect(typeof tool.parameters).toBe('object')
		})
	})

	// === init

	describe('init', () => {
		it('succeeds when root exists', async () => {
			await setup({})
			await expect(tool.init()).resolves.toBeUndefined()
		})
	})

	// === scan

	describe('scan operation', () => {
		it('lists files in a directory', async () => {
			await setup({ 'src/a.ts': 'a', 'src/b.ts': 'b' })
			const result = await execOk({ operation: 'scan', path: '.' })
			const output = result.output as Record<string, unknown>
			expect(output['count']).toBeGreaterThan(0)
		})

		it('filters by pattern', async () => {
			await setup({ 'a.ts': 'a', 'b.md': 'b' })
			const result = await execOk({ operation: 'scan', path: '.', pattern: '*.ts' })
			const output = result.output as Record<string, unknown>
			const entries = output['entries'] as Array<Record<string, unknown>>
			const filePaths = entries.filter((e) => e['type'] === 'file').map((e) => e['path'])
			for (const p of filePaths) {
				expect(p).toMatch(/\.ts$/)
			}
		})
	})

	// === stat

	describe('stat operation', () => {
		it('returns metadata for a file', async () => {
			await setup({ 'a.ts': 'hello' })
			const result = await execOk({ operation: 'stat', path: 'a.ts' })
			const output = result.output as Record<string, unknown>
			expect(output['file']).toBe(true)
			expect(output['size']).toBeGreaterThan(0)
		})

		it('fails for missing path', async () => {
			await setup({})
			const result = await execFail({ operation: 'stat', path: 'nope.ts' })
			expect(result.error).toBeDefined()
		})
	})

	// === search

	describe('search operation', () => {
		it('finds matches across files', async () => {
			await setup({ 'a.ts': 'hello world', 'b.ts': 'goodbye world' })
			const result = await execOk({ operation: 'search', query: 'world' })
			const output = result.output as Record<string, unknown>
			const matches = output['matches'] as unknown[]
			expect(matches.length).toBeGreaterThanOrEqual(2)
		})

		it('respects limit option', async () => {
			await setup({ 'a.ts': 'aaa\naaa\naaa' })
			const result = await execOk({ operation: 'search', query: 'aaa', limit: 1 })
			const output = result.output as Record<string, unknown>
			const matches = output['matches'] as unknown[]
			expect(matches).toHaveLength(1)
		})

		it('finds multiple occurrences on the same line', async () => {
			await setup({ 'a.ts': 'foo bar foo baz foo' })
			const result = await execOk({ operation: 'search', query: 'foo' })
			const output = result.output as Record<string, unknown>
			const matches = output['matches'] as Record<string, unknown>[]
			expect(matches).toHaveLength(3)
			expect(matches[0]?.['column']).toBe(1)
			expect(matches[1]?.['column']).toBe(9)
			expect(matches[2]?.['column']).toBe(17)
		})

		it('returns match length', async () => {
			await setup({ 'a.ts': 'hello world' })
			const result = await execOk({ operation: 'search', query: 'world' })
			const output = result.output as Record<string, unknown>
			const matches = output['matches'] as Record<string, unknown>[]
			expect(matches[0]?.['length']).toBe(5)
		})

		it('supports exact: false for case-insensitive search', async () => {
			await setup({ 'a.ts': 'Hello HELLO hello' })
			const result = await execOk({ operation: 'search', query: 'hello', exact: false })
			const output = result.output as Record<string, unknown>
			const matches = output['matches'] as unknown[]
			expect(matches).toHaveLength(3)
		})

		it('is case-sensitive by default (exact: true)', async () => {
			await setup({ 'a.ts': 'Hello HELLO hello' })
			const result = await execOk({ operation: 'search', query: 'hello' })
			const output = result.output as Record<string, unknown>
			const matches = output['matches'] as unknown[]
			expect(matches).toHaveLength(1)
		})
	})

	// === replace

	describe('replace operation', () => {
		it('replaces all occurrences and returns result', async () => {
			await setup({ 'a.ts': 'hello world hello', 'b.ts': 'hello there' })
			const result = await execOk({
				operation: 'replace',
				query: 'hello',
				content: 'goodbye',
			})
			const output = result.output as Record<string, unknown>
			expect(output['replaced']).toBe(3)
			expect(output['files']).toBe(2)
		})

		it('loads matched files into workspace', async () => {
			await setup({ 'a.ts': 'find me', 'b.ts': 'nothing' })
			await execOk({ operation: 'replace', query: 'find', content: 'found' })
			expect(filesystem.workspace.file('a.ts')?.content).toBe('found me')
			expect(filesystem.workspace.has('b.ts')).toBe(false)
		})

		it('supports exact: false for case-insensitive replace', async () => {
			await setup({ 'a.ts': 'Hello HELLO hello' })
			const result = await execOk({
				operation: 'replace',
				query: 'hello',
				content: 'hi',
				exact: false,
			})
			const output = result.output as Record<string, unknown>
			expect(output['replaced']).toBe(3)
			expect(filesystem.workspace.file('a.ts')?.content).toBe('hi hi hi')
		})

		it('supports regex replace', async () => {
			await setup({ 'a.ts': 'num 123 and 456' })
			const result = await execOk({
				operation: 'replace',
				query: '\\d+',
				content: 'N',
				regex: true,
			})
			const output = result.output as Record<string, unknown>
			expect(output['replaced']).toBe(2)
			expect(filesystem.workspace.file('a.ts')?.content).toBe('num N and N')
		})

		it('returns zero when no matches', async () => {
			await setup({ 'a.ts': 'hello world' })
			const result = await execOk({
				operation: 'replace',
				query: 'xyz',
				content: 'abc',
			})
			const output = result.output as Record<string, unknown>
			expect(output['replaced']).toBe(0)
			expect(output['files']).toBe(0)
		})

		it('fails without query', async () => {
			await setup({})
			const result = await tool.execute({ operation: 'replace', content: 'abc' })
			expect(result.ok).toBe(false)
		})

		it('fails without content (replacement string)', async () => {
			await setup({})
			const result = await tool.execute({ operation: 'replace', query: 'abc' })
			expect(result.ok).toBe(false)
		})
	})

	// === open

	describe('open operation', () => {
		it('loads a single file', async () => {
			await setup({ 'a.ts': 'content' })
			const result = await execOk({ operation: 'open', path: 'a.ts' })
			const output = result.output as Record<string, unknown>
			expect(output['path']).toBe('a.ts')
		})

		it('loads multiple files', async () => {
			await setup({ 'a.ts': 'a', 'b.ts': 'b' })
			const result = await execOk({ operation: 'open', path: ['a.ts', 'b.ts'] })
			const output = result.output as unknown[]
			expect(output).toHaveLength(2)
		})

		it('tracks opened files', async () => {
			await setup({ 'a.ts': 'content' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			const tracked = tool.files()
			expect(tracked.has('a.ts')).toBe(true)
		})

		it('fails for missing file', async () => {
			await setup({})
			const result = await execFail({ operation: 'open', path: 'nope.ts' })
			expect(result.error).toBeDefined()
		})

		it('fails with no path argument', async () => {
			await setup({})
			const result = await execFail({ operation: 'open' })
			expect(result.error).toBeDefined()
		})
	})

	// === read

	describe('read operation', () => {
		it('reads full file content', async () => {
			await setup({ 'a.ts': 'hello world' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			const result = await execOk({ operation: 'read', path: 'a.ts' })
			expect(result.output).toBe('hello world')
		})

		it('reads range', async () => {
			await setup({ 'a.ts': 'line1\nline2\nline3' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			const result = await execOk({
				operation: 'read',
				path: 'a.ts',
				range: { start: { line: 2, column: 1 }, end: { line: 2, column: 6 } },
			})
			const output = result.output as Record<string, unknown>
			expect(output['content']).toBe('line2')
		})

		it('fails for file not in workspace', async () => {
			await setup({})
			const result = await execFail({ operation: 'read', path: 'missing.ts' })
			expect(result.error).toBeDefined()
		})
	})

	// === write

	describe('write operation', () => {
		it('writes full content to new file', async () => {
			await setup({})
			const result = await execOk({ operation: 'write', path: 'new.ts', content: 'created' })
			const output = result.output as Record<string, unknown>
			expect(output['state']).toBe('created')
			expect(filesystem.workspace.read('new.ts')).toBe('created')
		})

		it('writes range to existing file', async () => {
			await setup({ 'a.ts': 'abcdef' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await execOk({
				operation: 'write',
				path: 'a.ts',
				content: 'XY',
				range: { start: { line: 1, column: 3 }, end: { line: 1, column: 5 } },
			})
			expect(filesystem.workspace.read('a.ts')).toBe('abXYef')
		})

		it('tracks written files', async () => {
			await setup({})
			await tool.execute({ operation: 'write', path: 'x.ts', content: 'data' })
			expect(tool.files().has('x.ts')).toBe(true)
		})
	})

	// === prepend

	describe('prepend operation', () => {
		it('inserts content at beginning', async () => {
			await setup({ 'a.ts': 'world' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await execOk({ operation: 'prepend', path: 'a.ts', content: 'hello ' })
			expect(filesystem.workspace.read('a.ts')).toBe('hello world')
		})

		it('fails for missing file', async () => {
			await setup({})
			const result = await execFail({ operation: 'prepend', path: 'missing.ts', content: 'x' })
			expect(result.error).toBeDefined()
		})
	})

	// === append

	describe('append operation', () => {
		it('inserts content at end', async () => {
			await setup({ 'a.ts': 'hello' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await execOk({ operation: 'append', path: 'a.ts', content: ' world' })
			expect(filesystem.workspace.read('a.ts')).toBe('hello world')
		})
	})

	// === remove

	describe('remove operation', () => {
		it('removes a single file from workspace', async () => {
			await setup({})
			await tool.execute({ operation: 'write', path: 'a.ts', content: 'c' })
			await execOk({ operation: 'remove', path: 'a.ts' })
			expect(filesystem.workspace.has('a.ts')).toBe(false)
		})

		it('removes all files when no path', async () => {
			await setup({})
			await tool.execute({ operation: 'write', path: 'a.ts', content: 'a' })
			await tool.execute({ operation: 'write', path: 'b.ts', content: 'b' })
			await execOk({ operation: 'remove' })
			expect(filesystem.workspace.count).toBe(0)
		})

		it('removes listed files', async () => {
			await setup({})
			await tool.execute({ operation: 'write', path: 'a.ts', content: 'a' })
			await tool.execute({ operation: 'write', path: 'b.ts', content: 'b' })
			await execOk({ operation: 'remove', path: ['a.ts', 'b.ts'] })
			expect(filesystem.workspace.count).toBe(0)
		})

		it('marks persisted file as deleted', async () => {
			await setup({ 'a.ts': 'content' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await execOk({ operation: 'remove', path: 'a.ts' })
			expect(filesystem.workspace.file('a.ts')?.state).toBe('deleted')
		})
	})

	// === move

	describe('move operation', () => {
		it('renames a file', async () => {
			await setup({})
			await tool.execute({ operation: 'write', path: 'old.ts', content: 'data' })
			const result = await execOk({ operation: 'move', from: 'old.ts', to: 'new.ts' })
			const output = result.output as Record<string, unknown>
			expect(output['found']).toBe(true)
			expect(filesystem.workspace.has('new.ts')).toBe(true)
			expect(filesystem.workspace.has('old.ts')).toBe(false)
		})

		it('returns found false for missing source', async () => {
			await setup({})
			const result = await execOk({ operation: 'move', from: 'nope.ts', to: 'new.ts' })
			const output = result.output as Record<string, unknown>
			expect(output['found']).toBe(false)
		})
	})

	// === list

	describe('list operation', () => {
		it('lists all workspace files with metadata', async () => {
			await setup({ 'a.ts': 'content' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await tool.execute({ operation: 'write', path: 'b.ts', content: 'new' })
			const result = await execOk({ operation: 'list' })
			const output = result.output as Record<string, unknown>[]
			expect(output).toHaveLength(2)
			const disk = output.find((f) => f['path'] === 'a.ts')
			const ws = output.find((f) => f['path'] === 'b.ts')
			expect(disk?.['persisted']).toBe(true)
			expect(ws?.['persisted']).toBe(false)
		})

		it('list() returns files and snapshot ids', async () => {
			await setup({ 'a.ts': 'content' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await tool.execute({ operation: 'snapshot' })
			const listing = tool.list()
			expect(listing.files).toHaveLength(1)
			expect(listing.files[0]['path']).toBe('a.ts')
			expect(listing.snapshots).toHaveLength(1)
		})
	})

	// === revert

	describe('revert operation', () => {
		it('reverts a single file', async () => {
			await setup({ 'a.ts': 'original' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await tool.execute({ operation: 'write', path: 'a.ts', content: 'changed' })
			await execOk({ operation: 'revert', path: 'a.ts' })
			expect(filesystem.workspace.read('a.ts')).toBe('original')
		})

		it('reverts all files', async () => {
			await setup({ 'a.ts': 'orig' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await tool.execute({ operation: 'write', path: 'a.ts', content: 'mod' })
			await tool.execute({ operation: 'write', path: 'b.ts', content: 'new' })
			await execOk({ operation: 'revert' })
			expect(filesystem.workspace.read('a.ts')).toBe('orig')
			expect(filesystem.workspace.has('b.ts')).toBe(false)
		})
	})

	// === persist

	describe('persist operation', () => {
		it('persists all dirty files to disk', async () => {
			await setup({ 'a.ts': 'old' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await tool.execute({ operation: 'write', path: 'a.ts', content: 'new' })
			const result = await execOk({ operation: 'persist' })
			expect(result.operation).toBe('persist')
			expect(readFromDisk(requireTestDir().root, 'a.ts')).toBe('new')
		})

		it('persists a single file to disk', async () => {
			await setup({})
			await tool.execute({ operation: 'write', path: 'x.ts', content: 'data' })
			const result = await execOk({ operation: 'persist', path: 'x.ts' })
			expect(result.operation).toBe('persist')
			expect(readFromDisk(requireTestDir().root, 'x.ts')).toBe('data')
		})

		it('persists listed files', async () => {
			await setup({})
			await tool.execute({ operation: 'write', path: 'x.ts', content: 'x' })
			await tool.execute({ operation: 'write', path: 'y.ts', content: 'y' })
			await execOk({ operation: 'persist', path: ['x.ts', 'y.ts'] })
			const dir = requireTestDir()
			expect(readFromDisk(dir.root, 'x.ts')).toBe('x')
			expect(readFromDisk(dir.root, 'y.ts')).toBe('y')
		})

		it('deletes file from disk on persist of deleted file', async () => {
			await setup({ 'a.ts': 'content' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			await tool.execute({ operation: 'remove', path: 'a.ts' })
			await execOk({ operation: 'persist', path: 'a.ts' })
			expect(existsOnDisk(requireTestDir().root, 'a.ts')).toBe(false)
		})
	})

	// === snapshot

	describe('snapshot operation', () => {
		it('returns snapshot metadata', async () => {
			await setup({ 'a.ts': 'data' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			const result = await execOk({ operation: 'snapshot' })
			const output = result.output as Record<string, unknown>
			expect(output['id']).toBeDefined()
			expect(output['created']).toBeGreaterThan(0)
			expect(output['count']).toBe(1)
		})
	})

	// === restore

	describe('restore operation', () => {
		it('restores workspace from snapshot', async () => {
			await setup({ 'a.ts': 'original' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			const snap = filesystem.snapshot()
			filesystem.workspace.clear()
			expect(filesystem.workspace.count).toBe(0)

			await execOk({
				operation: 'restore',
				snapshot: {
					id: snap.id,
					created: snap.created,
					files: snap.files.map((f) => ({
						path: f.path,
						content: f.content,
						encoding: f.encoding,
						state: f.state,
						persisted: f.persisted,
					})),
				},
			})
			expect(filesystem.workspace.count).toBe(1)
		})

		it('fails for invalid snapshot', async () => {
			await setup({})
			const result = await execFail({ operation: 'restore', snapshot: { bad: true } })
			expect(result.error).toBeDefined()
		})
	})

	// === forget

	describe('forget', () => {
		it('clears all tracked files', async () => {
			await setup({ 'a.ts': 'c' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			expect(tool.files().size).toBe(1)
			tool.forget()
			expect(tool.files().size).toBe(0)
		})

		it('removes a single tracked file', async () => {
			await setup({ 'a.ts': 'a', 'b.ts': 'b' })
			await tool.execute({ operation: 'open', path: ['a.ts', 'b.ts'] })
			expect(tool.forget('a.ts')).toBe(true)
			expect(tool.files().has('a.ts')).toBe(false)
			expect(tool.files().has('b.ts')).toBe(true)
		})

		it('returns false for non-tracked file', async () => {
			await setup({})
			expect(tool.forget('nope.ts')).toBe(false)
		})
	})

	// === Edge Cases

	describe('edge cases', () => {
		it('returns error for missing operation', async () => {
			await setup({})
			const result = await execFail({})
			expect(result.error).toBeDefined()
		})

		it('returns error for unknown operation', async () => {
			await setup({})
			const result = await execFail({ operation: 'explode' })
			expect(result.error).toBeDefined()
		})

		it('handles missing required string arguments gracefully', async () => {
			await setup({})
			const result = await execFail({ operation: 'read' })
			expect(result.error).toBeDefined()
		})

		it('returns duration on all operations', async () => {
			await setup({})
			const result = await tool.execute({ operation: 'list' })
			expect(result.duration).toBeGreaterThanOrEqual(0)
		})

		it('files() returns a copy not internal state', async () => {
			await setup({ 'a.ts': 'c' })
			await tool.execute({ operation: 'open', path: 'a.ts' })
			const files1 = tool.files()
			const files2 = tool.files()
			expect(files1).not.toBe(files2)
		})
	})

	// === Snapshot Stores

	describe('snapshot stores', () => {
		it('snapshots() returns empty when no stores configured', async () => {
			await setup({})
			expect(tool.snapshots()).toEqual([])
		})

		it('persists snapshot to stores on snapshot operation', async () => {
			const storeDir = await createTestDir()
			testDir = await createTestDir({ 'a.ts': 'content' })
			filesystem = createFileSystem({ root: testDir.root })
			const stores = createMCPStoreManager()
			stores.create({ path: storeDir.root })

			tool = new FileSystemTool({
				name: 'fs',
				summary: 'Test fs',
				description: 'test',
				filesystem,
				stores,
			})

			await tool.execute({ operation: 'open', path: 'a.ts' })
			const snapResult = await execOk({ operation: 'snapshot' })
			const output = snapResult.output as Record<string, unknown>
			const snapId = output['id'] as string

			// Snapshot id tracked
			expect(tool.snapshots()).toContain(snapId)

			// Snapshot written to store directory as JSON
			const entries = stores.entries()
			expect(entries.length).toBe(1)
			expect(entries[0]?.id).toBe(snapId)
			await destroyTestDir(storeDir)
		})

		it('restores by snapshot id from stores', async () => {
			const storeDir = await createTestDir()
			testDir = await createTestDir({ 'a.ts': 'content' })
			filesystem = createFileSystem({ root: testDir.root })
			const stores = createMCPStoreManager()
			stores.create({ path: storeDir.root })

			tool = new FileSystemTool({
				name: 'fs',
				summary: 'Test fs',
				description: 'test',
				filesystem,
				stores,
			})

			await tool.execute({ operation: 'open', path: 'a.ts' })
			await tool.execute({ operation: 'write', path: 'a.ts', content: 'modified' })
			const snapResult = await execOk({ operation: 'snapshot' })
			const snapId = (snapResult.output as Record<string, unknown>)['id'] as string

			// Clear workspace
			filesystem.workspace.clear()
			expect(filesystem.workspace.count).toBe(0)

			// Restore by id
			const restoreResult = await execOk({ operation: 'restore', snapshot: snapId })
			const restoreOutput = restoreResult.output as Record<string, unknown>
			expect(restoreOutput['restored']).toBe(true)
			expect(restoreOutput['id']).toBe(snapId)

			// Workspace restored
			expect(filesystem.workspace.count).toBe(1)
			expect(filesystem.workspace.file('a.ts')?.content).toBe('modified')
			await destroyTestDir(storeDir)
		})

		it('returns error for missing snapshot id', async () => {
			const storeDir = await createTestDir()
			testDir = await createTestDir()
			filesystem = createFileSystem({ root: testDir.root })
			const stores = createMCPStoreManager()
			stores.create({ path: storeDir.root })

			tool = new FileSystemTool({
				name: 'fs',
				summary: 'Test fs',
				description: 'test',
				filesystem,
				stores,
			})

			const result = await execFail({ operation: 'restore', snapshot: 'nonexistent-id' })
			expect(result.error).toBeDefined()
			await destroyTestDir(storeDir)
		})

		it('loads snapshot ids from stores on init', async () => {
			const storeDir = await createTestDir()
			testDir = await createTestDir({ 'a.ts': 'data' })
			filesystem = createFileSystem({ root: testDir.root })
			const stores = createMCPStoreManager()
			stores.create({ path: storeDir.root })

			// Create a tool, take a snapshot (saves to store)
			tool = new FileSystemTool({
				name: 'fs',
				summary: 'Test fs',
				description: 'test',
				filesystem,
				stores,
			})
			await tool.execute({ operation: 'open', path: 'a.ts' })
			const snapResult = await execOk({ operation: 'snapshot' })
			const snapId = (snapResult.output as Record<string, unknown>)['id'] as string

			// Create a fresh tool pointing to the same store dir
			const stores2 = createMCPStoreManager()
			stores2.create({ path: storeDir.root })
			const tool2 = new FileSystemTool({
				name: 'fs2',
				summary: 'Test fs',
				description: 'test2',
				filesystem: createFileSystem({ root: testDir.root }),
				stores: stores2,
			})
			await tool2.init()

			// Snapshot ids loaded from stores
			expect(tool2.snapshots()).toContain(snapId)
			await destroyTestDir(storeDir)
		})

		it('stores property returns the manager', async () => {
			const storeDir = await createTestDir()
			testDir = await createTestDir()
			filesystem = createFileSystem({ root: testDir.root })
			const stores = createMCPStoreManager()
			stores.create({ path: storeDir.root })

			tool = new FileSystemTool({
				name: 'fs',
				summary: 'Test fs',
				description: 'test',
				filesystem,
				stores,
			})
			expect(tool.stores).toBe(stores)
			await destroyTestDir(storeDir)
		})

		it('stores is undefined when not configured', async () => {
			await setup({})
			expect(tool.stores).toBeUndefined()
		})
	})

	// === Schema Audit

	describe('schema audit', () => {
		it('top-level schema is type object', async () => {
			await setup({})
			expect(tool.parameters['type']).toBe('object')
		})

		it('has required operation', async () => {
			await setup({})
			expect(tool.parameters['required']).toEqual(['operation'])
		})

		it('operation has enum with all 16 operations', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const operations = props['operation']['enum'] as string[]
			expect(operations).toHaveLength(16)
			const expected = [
				'scan',
				'stat',
				'search',
				'replace',
				'open',
				'read',
				'write',
				'prepend',
				'append',
				'remove',
				'move',
				'list',
				'revert',
				'persist',
				'snapshot',
				'restore',
			]
			for (const op of expected) {
				expect(operations).toContain(op)
			}
		})

		it('path uses oneOf with string and array of strings', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const pathSchema = props['path']
			expect(pathSchema['oneOf']).toBeDefined()
			const oneOf = pathSchema['oneOf'] as Record<string, unknown>[]
			expect(oneOf).toHaveLength(2)
			expect(oneOf[0]['type']).toBe('string')
			expect(oneOf[1]['type']).toBe('array')
		})

		it('range has required start and end with line and column', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const range = props['range']
			expect(range['required']).toEqual(['start', 'end'])
			const rangeProps = range['properties'] as Record<string, Record<string, unknown>>
			expect(rangeProps['start']['required']).toEqual(['line', 'column'])
			expect(rangeProps['end']['required']).toEqual(['line', 'column'])
		})

		it('snapshot uses oneOf with string and object', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const snap = props['snapshot']
			expect(snap['oneOf']).toBeDefined()
			const oneOf = snap['oneOf'] as Record<string, unknown>[]
			expect(oneOf[0]['type']).toBe('string')
			expect(oneOf[1]['type']).toBe('object')
		})

		it('snapshot object schema has required fields', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const snap = props['snapshot']
			const oneOf = snap['oneOf'] as Record<string, unknown>[]
			const objSchema = oneOf[1]
			expect(objSchema['required']).toEqual(['id', 'created', 'files'])
		})

		it('all array properties have items defined', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const arrayFields = ['exclude', 'paths']
			for (const field of arrayFields) {
				const prop = props[field]
				expect(prop['type']).toBe('array')
				expect(prop['items']).toBeDefined()
			}
		})

		it('content is type string', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			expect(props['content']['type']).toBe('string')
		})

		it('query is type string', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			expect(props['query']['type']).toBe('string')
		})

		it('from and to are type string', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			expect(props['from']['type']).toBe('string')
			expect(props['to']['type']).toBe('string')
		})

		it('boolean fields are type boolean', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			expect(props['regex']['type']).toBe('boolean')
			expect(props['force']['type']).toBe('boolean')
		})

		it('numeric fields are type number', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			expect(props['depth']['type']).toBe('number')
			expect(props['size']['type']).toBe('number')
			expect(props['limit']['type']).toBe('number')
			expect(props['context']['type']).toBe('number')
		})

		it('every property has a description', async () => {
			await setup({})
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			for (const value of Object.values(props)) {
				expect(typeof value['description']).toBe('string')
				expect((value['description'] as string).length).toBeGreaterThan(0)
			}
		})

		it('passes deep recursive schema validation', async () => {
			await setup({})
			const errors = validateSchema(tool.parameters)
			expect(errors).toEqual([])
		})
	})
})
