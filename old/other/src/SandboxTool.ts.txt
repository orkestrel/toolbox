import type {
	SandboxOperation,
	SandboxToolInput,
	SandboxToolInterface,
	SandboxToolResult,
} from '../types.js'
import type { SandboxInterface } from '@orkestrel/sandbox'
import { createSandbox } from '@orkestrel/sandbox'
import { allocateRoot } from '@orkestrel/sandbox'
import { SANDBOX_TOOL_PARAMETERS } from '../constants.js'

/**
 * Standard tool wrapping on-disk sandbox operations for agent/MCP integration.
 *
 * @remarks
 * Manages one or more isolated temporary directories. Each sandbox has a
 * unique id returned by `create`. The model sends `{ operation, id?, ... }`
 * and the tool routes to the correct sandbox method.
 *
 * All file paths are guarded against traversal outside the sandbox root.
 */
export class SandboxTool implements SandboxToolInterface {
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	readonly #sandboxes: Map<string, SandboxInterface> = new Map()
	#counter: number = 0

	constructor(input: SandboxToolInput) {
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		if (input.sandbox) {
			const id = this.#nextId()
			this.#sandboxes.set(id, input.sandbox)
		}
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
		return SANDBOX_TOOL_PARAMETERS
	}

	async execute(args: Readonly<Record<string, unknown>>): Promise<SandboxToolResult> {
		const start = performance.now()
		const operation = args['operation']

		if (typeof operation !== 'string') {
			return this.#fail('create', 'Missing or invalid operation', start)
		}

		try {
			switch (operation) {
				case 'create':
					return await this.#handleCreate(args, start)
				case 'write':
					return await this.#handleWrite(args, start)
				case 'read':
					return await this.#handleRead(args, start)
				case 'scan':
					return await this.#handleScan(args, start)
				case 'entries':
					return await this.#handleEntries(args, start)
				case 'ensure':
					return await this.#handleEnsure(args, start)
				case 'remove':
					return await this.#handleRemove(args, start)
				case 'stat':
					return await this.#handleStat(args, start)
				case 'has':
					return await this.#handleHas(args, start)
				case 'execute':
					return await this.#handleExecute(args, start)
				case 'destroy':
					return await this.#handleDestroy(args, start)
				case 'list':
					return this.#handleList(start)
				default:
					return this.#fail(operation, `Unknown operation: ${operation}`, start)
			}
		} catch (thrown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return this.#fail(this.#toOperation(operation), message, start)
		}
	}

	sandbox(id: string): SandboxInterface | undefined {
		return this.#sandboxes.get(id)
	}

	sandboxes(): ReadonlyMap<string, SandboxInterface> {
		return new Map(this.#sandboxes)
	}

	destroy(): void {
		for (const sb of this.#sandboxes.values()) {
			sb.destroy().catch(() => {
				/* ignore */
			})
		}
		this.#sandboxes.clear()
	}

	// === Operation handlers

	async #handleCreate(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const label = typeof args['label'] === 'string' ? args['label'] : undefined
		const symlinkNodeModules =
			typeof args['symlinkNodeModules'] === 'boolean' ? args['symlinkNodeModules'] : undefined
		const root = label ? allocateRoot(label) : undefined
		const sb = await createSandbox({
			root,
			symlinkNodeModules,
		})
		const id = this.#nextId()
		this.#sandboxes.set(id, sb)
		return this.#ok('create', { id, root: sb.root }, start)
	}

	async #handleWrite(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const sb = this.#requireSandbox(args)
		const path = this.#requireString(args, 'path')
		const content = this.#requireString(args, 'content')
		await sb.write(path, content)
		return this.#ok('write', { path }, start)
	}

	async #handleRead(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const sb = this.#requireSandbox(args)
		const path = this.#requireString(args, 'path')
		const content = await sb.read(path)
		return this.#ok('read', { path, content }, start)
	}

	async #handleEntries(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const sb = this.#requireSandbox(args)
		const path = typeof args['path'] === 'string' ? args['path'] : '.'
		const items = await sb.entries(path)
		return this.#ok('entries', { path, entries: items }, start)
	}

	async #handleScan(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const sb = this.#requireSandbox(args)
		const path = typeof args['path'] === 'string' ? args['path'] : '.'
		const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : undefined
		const depth = typeof args['depth'] === 'number' ? args['depth'] : undefined
		const size = typeof args['size'] === 'number' ? args['size'] : undefined
		const rawExclude = args['exclude']
		const exclude: string[] = []
		if (Array.isArray(rawExclude)) {
			for (const item of rawExclude) {
				if (typeof item === 'string') exclude.push(item)
			}
		}
		const result = await sb.scan(path, {
			pattern,
			exclude: exclude.length > 0 ? exclude : undefined,
			depth,
			size,
		})
		return this.#ok('scan', result, start)
	}

	async #handleEnsure(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const sb = this.#requireSandbox(args)
		const path = this.#requireString(args, 'path')
		const content = typeof args['content'] === 'string' ? args['content'] : undefined
		const abs = await sb.ensure(path, content)
		return this.#ok('ensure', { path, absolute: abs }, start)
	}

	async #handleRemove(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const sb = this.#requireSandbox(args)
		const path = this.#requireString(args, 'path')
		const recursive = typeof args['recursive'] === 'boolean' ? args['recursive'] : false
		const force = typeof args['force'] === 'boolean' ? args['force'] : false
		await sb.remove(path, { recursive, force })
		return this.#ok('remove', { path }, start)
	}

	async #handleStat(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const sb = this.#requireSandbox(args)
		const path = this.#requireString(args, 'path')
		const entry = await sb.stat(path)
		if (entry === undefined) {
			return this.#fail('stat', `Path not found: ${path}`, start)
		}
		return this.#ok(
			'stat',
			{
				path: entry.path,
				size: entry.size,
				lines: entry.lines,
				file: entry.file,
				modified: entry.modified,
			},
			start,
		)
	}

	async #handleHas(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const sb = this.#requireSandbox(args)
		const path = this.#requireString(args, 'path')
		const found = await sb.has(path)
		return this.#ok('has', { path, found }, start)
	}

	async #handleExecute(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const sb = this.#requireSandbox(args)
		const command = this.#requireString(args, 'command')
		const rawArgs = args['args']
		const processArgs: string[] = []
		if (Array.isArray(rawArgs)) {
			for (const a of rawArgs) {
				if (typeof a === 'string') processArgs.push(a)
			}
		}
		const timeout = typeof args['timeout'] === 'number' ? args['timeout'] : undefined
		const shell = typeof args['shell'] === 'boolean' ? args['shell'] : undefined
		const environment: Record<string, string> = {}
		const rawEnv = args['environment']
		if (typeof rawEnv === 'object' && rawEnv !== null && !Array.isArray(rawEnv)) {
			for (const [key, value] of Object.entries(rawEnv)) {
				if (typeof value === 'string') environment[key] = value
			}
		}
		const result = await sb.execute(command, processArgs, {
			timeout,
			shell,
			environment: Object.keys(environment).length > 0 ? environment : undefined,
		})
		return this.#ok('execute', result, start)
	}

	async #handleDestroy(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<SandboxToolResult> {
		const id = this.#requireString(args, 'id')
		const sb = this.#sandboxes.get(id)
		if (!sb) {
			return this.#fail('destroy', `Sandbox not found: ${id}`, start)
		}
		await sb.destroy()
		this.#sandboxes.delete(id)
		return this.#ok('destroy', { id, destroyed: true }, start)
	}

	#handleList(start: number): SandboxToolResult {
		const items: unknown[] = []
		for (const [id, sb] of this.#sandboxes) {
			items.push({ id, root: sb.root, destroyed: sb.destroyed })
		}
		return this.#ok('list', { sandboxes: items, count: this.#sandboxes.size }, start)
	}

	// === Private helpers

	#requireString(args: Readonly<Record<string, unknown>>, key: string): string {
		const value = args[key]
		if (typeof value !== 'string') {
			throw new Error(`Missing or invalid '${key}' argument — expected string`)
		}
		return value
	}

	#requireSandbox(args: Readonly<Record<string, unknown>>): SandboxInterface {
		const id = this.#requireString(args, 'id')
		const sb = this.#sandboxes.get(id)
		if (!sb) {
			throw new Error(`Sandbox not found: ${id}`)
		}
		return sb
	}

	#nextId(): string {
		this.#counter++
		return `sb-${this.#counter}`
	}

	#ok(operation: SandboxOperation, output: unknown, start: number): SandboxToolResult {
		return {
			operation,
			ok: true,
			output,
			error: undefined,
			duration: performance.now() - start,
		}
	}

	#fail(operation: SandboxOperation | string, message: string, start: number): SandboxToolResult {
		return {
			operation: this.#toOperation(operation),
			ok: false,
			output: undefined,
			error: message,
			duration: performance.now() - start,
		}
	}

	#toOperation(value: string): SandboxOperation {
		const operations: Record<string, SandboxOperation> = {
			create: 'create',
			write: 'write',
			read: 'read',
			scan: 'scan',
			entries: 'entries',
			ensure: 'ensure',
			remove: 'remove',
			stat: 'stat',
			has: 'has',
			execute: 'execute',
			destroy: 'destroy',
			list: 'list',
		}
		return operations[value] ?? 'create'
	}
}
