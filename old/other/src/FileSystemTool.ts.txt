import type {
	FileSystemOperation,
	FileSystemToolInput,
	FileSystemToolInterface,
	FileSystemToolResult,
	MCPStoreManagerInterface,
} from '../types.js'
import type {
	FileInterface,
	FileSystemError,
	FileSystemInterface,
	Range,
	Snapshot,
} from '@orkestrel/filesystem'
import { isRecord } from '@orkestrel/core'
import { FILESYSTEM_TOOL_PARAMETERS } from '../constants.js'

/**
 * Standard tool wrapping a FileSystemInterface for agent/MCP integration.
 *
 * @remarks
 * Dispatches filesystem operations based on `args.operation` and returns
 * a structured `FileSystemToolResult`. Exposes a JSON Schema via `parameters`
 * so models can generate valid tool calls.
 *
 * When `stores` is provided, snapshots are automatically persisted to disk
 * and loaded on `init()`, providing cross-session durability.
 */
export class FileSystemTool implements FileSystemToolInterface {
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	readonly #filesystem: FileSystemInterface
	readonly #stores: MCPStoreManagerInterface | undefined
	readonly #tracked: Map<string, FileInterface> = new Map()
	readonly #snapshotIds: string[] = []

	constructor(input: FileSystemToolInput) {
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		this.#filesystem = input.filesystem
		this.#stores = input.stores
	}

	get name(): string {
		return this.#name
	}

	get summary(): string {
		return this.#summary
	}

	get description(): string {
		return this.#description
	}

	get parameters(): Record<string, unknown> {
		return FILESYSTEM_TOOL_PARAMETERS
	}

	get stores(): MCPStoreManagerInterface | undefined {
		return this.#stores
	}

	async init(): Promise<void> {
		// Validate root path exists if configured
		const root = this.#filesystem.context.root
		if (root) {
			const result = await this.#filesystem.stat('.')
			if (!result.success) {
				throw new Error(`FileSystemTool init failed: root path does not exist — ${root}`)
			}
		}

		// Load snapshots from stores
		if (this.#stores) {
			await this.#stores.load()
			for (const entry of this.#stores.entries()) {
				const data = entry.data
				const id = data['id']
				if (
					typeof id === 'string' &&
					typeof data['created'] === 'number' &&
					Array.isArray(data['files'])
				) {
					this.#snapshotIds.push(id)
				}
			}
		}
	}

	async execute(args: Readonly<Record<string, unknown>>): Promise<FileSystemToolResult> {
		const start = performance.now()
		const operation = args['operation']

		if (typeof operation !== 'string') {
			return this.#fail('scan', 'Missing or invalid operation', start)
		}

		try {
			switch (operation) {
				case 'scan':
					return await this.#handleScan(args, start)
				case 'stat':
					return await this.#handleStat(args, start)
				case 'search':
					return await this.#handleSearch(args, start)
				case 'replace':
					return await this.#handleReplace(args, start)
				case 'open':
					return await this.#handleOpen(args, start)
				case 'read':
					return this.#handleRead(args, start)
				case 'write':
					return this.#handleWrite(args, start)
				case 'prepend':
					return this.#handlePrepend(args, start)
				case 'append':
					return this.#handleAppend(args, start)
				case 'remove':
					return this.#handleRemove(args, start)
				case 'move':
					return this.#handleMove(args, start)
				case 'list':
					return this.#handleList(start)
				case 'revert':
					return this.#handleRevert(args, start)
				case 'persist':
					return await this.#handlePersist(args, start)
				case 'snapshot':
					return await this.#handleSnapshot(start)
				case 'restore':
					return this.#handleRestore(args, start)
				default:
					return this.#fail(operation, `Unknown operation: ${operation}`, start)
			}
		} catch (thrown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return this.#fail(operation, message, start)
		}
	}

	files(): ReadonlyMap<string, FileInterface> {
		return new Map(this.#tracked)
	}

	snapshots(): readonly string[] {
		return [...this.#snapshotIds]
	}

	/**
	 * Returns workspace files and stored snapshot ids.
	 *
	 * @returns structured listing of files and available snapshots
	 */
	list(): {
		readonly files: readonly Record<string, unknown>[]
		readonly snapshots: readonly string[]
	} {
		const files = this.#filesystem.workspace.files().map((file) => ({
			path: file.path,
			state: file.state,
			persisted: file.persisted,
			size: file.size,
			lines: file.lines,
		}))
		return { files, snapshots: [...this.#snapshotIds] }
	}

	forget(): void
	forget(path: string): boolean
	forget(path?: string): boolean | void {
		if (path === undefined) {
			this.#tracked.clear()
			return
		}
		return this.#tracked.delete(path)
	}

	// === Operation handlers

	async #handleScan(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<FileSystemToolResult> {
		const path = this.#requireString(args, 'path')
		const options: Record<string, unknown> = {}
		if (typeof args['pattern'] === 'string') options['pattern'] = args['pattern']
		if (Array.isArray(args['exclude'])) options['exclude'] = args['exclude']
		if (typeof args['depth'] === 'number') options['depth'] = args['depth']
		if (typeof args['size'] === 'number') options['size'] = args['size']

		const result = await this.#filesystem.scan(path, options)
		return this.#ok('scan', result, start)
	}

	async #handleStat(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<FileSystemToolResult> {
		const path = this.#requireString(args, 'path')
		const result = await this.#filesystem.stat(path)
		if (!result.success) {
			return this.#failWithError('stat', result.error, start)
		}
		return this.#ok('stat', result.value, start)
	}

	async #handleSearch(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<FileSystemToolResult> {
		const query = this.#requireString(args, 'query')
		const options: Record<string, unknown> = {}
		if (Array.isArray(args['paths'])) options['paths'] = args['paths']
		if (typeof args['pattern'] === 'string') options['pattern'] = args['pattern']
		if (Array.isArray(args['exclude'])) options['exclude'] = args['exclude']
		if (typeof args['regex'] === 'boolean') options['regex'] = args['regex']
		if (typeof args['exact'] === 'boolean') options['exact'] = args['exact']
		if (typeof args['limit'] === 'number') options['limit'] = args['limit']
		if (typeof args['context'] === 'number') options['context'] = args['context']

		const result = await this.#filesystem.search(query, options)
		return this.#ok('search', result, start)
	}

	async #handleReplace(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<FileSystemToolResult> {
		const query = this.#requireString(args, 'query')
		const replacement = this.#requireString(args, 'content')
		const options: Record<string, unknown> = {}
		if (Array.isArray(args['paths'])) options['paths'] = args['paths']
		if (typeof args['pattern'] === 'string') options['pattern'] = args['pattern']
		if (Array.isArray(args['exclude'])) options['exclude'] = args['exclude']
		if (typeof args['regex'] === 'boolean') options['regex'] = args['regex']
		if (typeof args['exact'] === 'boolean') options['exact'] = args['exact']
		if (typeof args['limit'] === 'number') options['limit'] = args['limit']

		const result = await this.#filesystem.replace(query, replacement, options)
		return this.#ok('replace', result, start)
	}

	async #handleOpen(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<FileSystemToolResult> {
		const path = args['path']
		const options: Record<string, unknown> = {}
		if (typeof args['force'] === 'boolean') options['force'] = args['force']
		if (typeof args['encoding'] === 'string') options['encoding'] = args['encoding']

		if (typeof path === 'string') {
			const result = await this.#filesystem.open(path, options)
			if (result.success) {
				this.#tracked.set(result.value.path, result.value)
				return this.#ok(
					'open',
					{ path: result.value.path, size: result.value.size, lines: result.value.lines },
					start,
				)
			}
			return this.#failWithError('open', result.error, start)
		}

		if (Array.isArray(path)) {
			const paths = path.filter((p): p is string => typeof p === 'string')
			const results = await this.#filesystem.open(paths, options)
			const output: unknown[] = []
			for (const result of results) {
				if (result.success) {
					this.#tracked.set(result.value.path, result.value)
					output.push({
						path: result.value.path,
						size: result.value.size,
						lines: result.value.lines,
					})
				} else {
					output.push({ error: result.error })
				}
			}
			return this.#ok('open', output, start)
		}

		return this.#fail('open', 'Missing path argument', start)
	}

	#handleRead(args: Readonly<Record<string, unknown>>, start: number): FileSystemToolResult {
		const path = this.#requireString(args, 'path')
		const workspace = this.#filesystem.workspace
		const rangeArg = args['range']

		if (isRecord(rangeArg)) {
			const range = this.#parseRange(rangeArg)
			const result = workspace.read(path, range)
			if (result === undefined) {
				return this.#fail('read', `File not in workspace: ${path}`, start)
			}
			return this.#ok('read', result, start)
		}

		const content = workspace.read(path)
		if (content === undefined) {
			return this.#fail('read', `File not in workspace: ${path}`, start)
		}
		return this.#ok('read', content, start)
	}

	#handleWrite(args: Readonly<Record<string, unknown>>, start: number): FileSystemToolResult {
		const path = this.#requireString(args, 'path')
		const content = this.#requireString(args, 'content')
		const workspace = this.#filesystem.workspace
		const rangeArg = args['range']

		if (isRecord(rangeArg)) {
			const range = this.#parseRange(rangeArg)
			workspace.write(path, content, range)
		} else {
			workspace.write(path, content)
		}

		const file = workspace.file(path)
		if (file) this.#tracked.set(path, file)
		return this.#ok('write', { path, state: file?.state }, start)
	}

	#handlePrepend(args: Readonly<Record<string, unknown>>, start: number): FileSystemToolResult {
		const path = this.#requireString(args, 'path')
		const content = this.#requireString(args, 'content')
		this.#filesystem.workspace.prepend(path, content)
		const file = this.#filesystem.workspace.file(path)
		if (file) this.#tracked.set(path, file)
		return this.#ok('prepend', { path, state: file?.state }, start)
	}

	#handleAppend(args: Readonly<Record<string, unknown>>, start: number): FileSystemToolResult {
		const path = this.#requireString(args, 'path')
		const content = this.#requireString(args, 'content')
		this.#filesystem.workspace.append(path, content)
		const file = this.#filesystem.workspace.file(path)
		if (file) this.#tracked.set(path, file)
		return this.#ok('append', { path, state: file?.state }, start)
	}

	#handleRemove(args: Readonly<Record<string, unknown>>, start: number): FileSystemToolResult {
		const workspace = this.#filesystem.workspace
		const path = args['path']

		if (path === undefined) {
			workspace.remove()
			return this.#ok('remove', { removed: 'all' }, start)
		}

		if (typeof path === 'string') {
			const found = workspace.remove(path)
			return this.#ok('remove', { path, found }, start)
		}

		if (Array.isArray(path)) {
			const paths = path.filter((p): p is string => typeof p === 'string')
			const found = workspace.remove(paths)
			return this.#ok('remove', { paths, found }, start)
		}

		return this.#fail('remove', 'Invalid path argument', start)
	}

	#handleMove(args: Readonly<Record<string, unknown>>, start: number): FileSystemToolResult {
		const from = this.#requireString(args, 'from')
		const to = this.#requireString(args, 'to')
		const found = this.#filesystem.workspace.move(from, to)
		return this.#ok('move', { from, to, found }, start)
	}

	#handleList(start: number): FileSystemToolResult {
		const files = this.#filesystem.workspace.files()
		const output = files.map((file) => ({
			path: file.path,
			state: file.state,
			persisted: file.persisted,
			size: file.size,
			lines: file.lines,
		}))
		return this.#ok('list', output, start)
	}

	#handleRevert(args: Readonly<Record<string, unknown>>, start: number): FileSystemToolResult {
		const workspace = this.#filesystem.workspace
		const path = args['path']

		if (path === undefined) {
			workspace.revert()
			return this.#ok('revert', { reverted: 'all' }, start)
		}

		if (typeof path === 'string') {
			const found = workspace.revert(path)
			return this.#ok('revert', { path, found }, start)
		}

		if (Array.isArray(path)) {
			const paths = path.filter((p): p is string => typeof p === 'string')
			const found = workspace.revert(paths)
			return this.#ok('revert', { paths, found }, start)
		}

		return this.#fail('revert', 'Invalid path argument', start)
	}

	async #handlePersist(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<FileSystemToolResult> {
		const path = args['path']

		if (path === undefined) {
			const result = await this.#filesystem.persist()
			return this.#ok('persist', result, start)
		}

		if (typeof path === 'string') {
			const result = await this.#filesystem.persist(path)
			if (!result.success) {
				return this.#failWithError('persist', result.error, start)
			}
			return this.#ok('persist', { path, persisted: true }, start)
		}

		if (Array.isArray(path)) {
			const paths = path.filter((p): p is string => typeof p === 'string')
			const results = await this.#filesystem.persist(paths)
			const output: unknown[] = []
			for (const result of results) {
				if (result.success) {
					output.push({ persisted: true })
				} else {
					output.push({ error: result.error })
				}
			}
			return this.#ok('persist', output, start)
		}

		return this.#fail('persist', 'Invalid path argument', start)
	}

	async #handleSnapshot(start: number): Promise<FileSystemToolResult> {
		const snapshot = this.#filesystem.snapshot()

		// Track the snapshot ID
		if (!this.#snapshotIds.includes(snapshot.id)) {
			this.#snapshotIds.push(snapshot.id)
		}

		// Persist snapshot to stores
		if (this.#stores) {
			await this.#stores.write({
				id: snapshot.id,
				data: {
					id: snapshot.id,
					created: snapshot.created,
					files: snapshot.files.map((f) => ({
						path: f.path,
						content: f.content,
						encoding: f.encoding,
						state: f.state,
						persisted: f.persisted,
					})),
				},
			})
		}

		return this.#ok(
			'snapshot',
			{ id: snapshot.id, created: snapshot.created, count: snapshot.files.length },
			start,
		)
	}

	#handleRestore(args: Readonly<Record<string, unknown>>, start: number): FileSystemToolResult {
		const snapshotArg = args['snapshot']

		// Support restoring by id from stores
		if (typeof snapshotArg === 'string' && this.#stores) {
			const entry = this.#stores.entry(snapshotArg)
			if (!entry) {
				return this.#fail('restore', `Snapshot not found: ${snapshotArg}`, start)
			}
			const data = entry.data
			const id = data['id']
			const created = data['created']
			const files = data['files']
			if (typeof id !== 'string' || typeof created !== 'number' || !Array.isArray(files)) {
				return this.#fail('restore', `Invalid snapshot data for: ${snapshotArg}`, start)
			}
			const typed: Snapshot = { id, created, files }
			this.#filesystem.restore(typed)
			return this.#ok('restore', { restored: true, id: snapshotArg }, start)
		}

		if (
			!isRecord(snapshotArg) ||
			typeof snapshotArg['id'] !== 'string' ||
			typeof snapshotArg['created'] !== 'number' ||
			!Array.isArray(snapshotArg['files'])
		) {
			return this.#fail('restore', 'Missing or invalid snapshot argument', start)
		}
		// Build a typed Snapshot from the validated record
		const typed: Snapshot = {
			id: snapshotArg['id'],
			created: snapshotArg['created'],
			files: snapshotArg['files'],
		}
		this.#filesystem.restore(typed)
		return this.#ok('restore', { restored: true }, start)
	}

	// === Private helpers

	#requireString(args: Readonly<Record<string, unknown>>, key: string): string {
		const value = args[key]
		if (typeof value !== 'string') {
			throw new Error(`Missing or invalid '${key}' argument — expected string`)
		}
		return value
	}

	#parseRange(rangeObj: Record<string, unknown>): Range {
		const start = rangeObj['start']
		const end = rangeObj['end']
		if (!isRecord(start) || !isRecord(end)) {
			throw new Error('Range must have start and end positions')
		}
		return {
			start: {
				line: typeof start['line'] === 'number' ? start['line'] : 1,
				column: typeof start['column'] === 'number' ? start['column'] : 1,
			},
			end: {
				line: typeof end['line'] === 'number' ? end['line'] : 1,
				column: typeof end['column'] === 'number' ? end['column'] : 1,
			},
		}
	}

	#ok(operation: FileSystemOperation, output: unknown, start: number): FileSystemToolResult {
		return {
			operation,
			ok: true,
			output,
			error: undefined,
			duration: performance.now() - start,
		}
	}

	#fail(
		operation: FileSystemOperation | string,
		message: string,
		start: number,
	): FileSystemToolResult {
		const op = this.#toOperation(operation)
		return {
			operation: op,
			ok: false,
			output: undefined,
			error: { code: this.#inferErrorCode(op, message), message, path: undefined },
			duration: performance.now() - start,
		}
	}

	#failWithError(
		operation: FileSystemOperation,
		error: FileSystemError,
		start: number,
	): FileSystemToolResult {
		return {
			operation,
			ok: false,
			output: undefined,
			error,
			duration: performance.now() - start,
		}
	}

	#toOperation(value: string): FileSystemOperation {
		const operations: Record<string, FileSystemOperation> = {
			scan: 'scan',
			stat: 'stat',
			search: 'search',
			replace: 'replace',
			open: 'open',
			read: 'read',
			write: 'write',
			prepend: 'prepend',
			append: 'append',
			remove: 'remove',
			move: 'move',
			list: 'list',
			revert: 'revert',
			persist: 'persist',
			snapshot: 'snapshot',
			restore: 'restore',
		}
		return operations[value] ?? 'scan'
	}

	#inferErrorCode(operation: FileSystemOperation, message: string): FileSystemError['code'] {
		if (message.includes('not in workspace') || message.includes('not found')) {
			return 'FILE_NOT_LOADED'
		}
		if (message.includes('Missing') || message.includes('Invalid') || message.includes('Unknown')) {
			return 'INVALID_PATH'
		}
		if (operation === 'read') return 'READ_FAILED'
		if (operation === 'write' || operation === 'prepend' || operation === 'append') {
			return 'WRITE_FAILED'
		}
		if (operation === 'restore') return 'SNAPSHOT_INVALID'
		if (operation === 'move') return 'MOVE_CONFLICT'
		return 'INVALID_PATH'
	}
}
