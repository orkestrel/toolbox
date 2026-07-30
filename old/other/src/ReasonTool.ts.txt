import type {
	ForgetResult,
	ImportResult,
	MCPStoreManagerInterface,
	ReasonToolInput,
	ReasonToolInterface,
} from '../types.js'
import type { ReasonDefinition, ReasonResult, ReasonInterface, Subject } from '@orkestrel/reason'
import { isSubject, isReasonDefinition, createReasonError } from '@orkestrel/reason'
import { isObject, prop, toRecord } from '@orkestrel/core'
import {
	REASON_TOOL_PARAMETERS,
	DEFINITION_FILE_EXTENSION,
	DEFINITION_SCRIPT_EXTENSIONS,
} from '../constants.js'
import { resolveDefinitionModule } from '../helpers.js'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Standard tool wrapping a Reason instance for agent integration.
 *
 * @remarks
 * Resolves a `ReasonDefinition` from either an inline object or a pre-loaded id,
 * then delegates to the underlying `ReasonInterface`.
 *
 * Supports `memory` (runtime caching) and `persist` (disk storage) for definitions,
 * as well as loading definitions from stores at construction.
 */
export class ReasonTool implements ReasonToolInterface {
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	#reason: ReasonInterface
	#definitionMap: Map<string, ReasonDefinition> = new Map()
	readonly #memory: boolean
	readonly #stores: MCPStoreManagerInterface | undefined

	constructor(input: ReasonToolInput) {
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		this.#reason = input.reason
		this.#memory = input.memory ?? false
		this.#stores = input.stores

		// Load constructor definitions (in-memory only)
		if (input.definitions) {
			for (const def of input.definitions) {
				this.#definitionMap.set(def.id, def)
			}
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
		return REASON_TOOL_PARAMETERS
	}

	get stores(): MCPStoreManagerInterface | undefined {
		return this.#stores
	}

	/**
	 * Returns a snapshot of all stored definitions.
	 *
	 * @returns a read-only map of definition id to definition
	 */
	definitions(): ReadonlyMap<string, ReasonDefinition> {
		return new Map(this.#definitionMap)
	}

	/**
	 * Returns a summary of all stored definitions.
	 *
	 * @returns an array of definition summaries with id, name, and type
	 */
	list(): readonly { readonly id: string; readonly name: string; readonly type: string }[] {
		return [...this.#definitionMap.values()].map((def) => ({
			id: def.id,
			name: def.name,
			type: def.type,
		}))
	}

	/**
	 * Loads definition files from configured stores asynchronously.
	 *
	 * @remarks
	 * Call after construction to load definition files from all configured
	 * stores. Supports `.json`, `.js`, `.mjs`, `.ts`, and `.mts` files.
	 *
	 * Safe to call multiple times — subsequent calls reload definitions,
	 * which allows picking up file changes at runtime.
	 */
	async init(): Promise<void> {
		if (!this.#stores) return

		await this.#stores.load()

		for (const entry of this.#stores.entries()) {
			if (isReasonDefinition(entry.data)) {
				this.#definitionMap.set(entry.id, entry.data)
			}
		}
	}

	/**
	 * Imports a definition from a file path and stores it in memory.
	 *
	 * @remarks
	 * Supports `.json`, `.js`, `.mjs`, `.ts`, and `.mts` files.
	 * JSON files are parsed directly. Script files are loaded via dynamic `import()`.
	 * If stores are configured, the definition is also persisted to the writable store.
	 *
	 * @param path - absolute or relative path to the definition file
	 * @returns result indicating success/failure, message, and the imported definition id
	 */
	async import(path: string): Promise<ImportResult> {
		const resolvedPath = nodePath.resolve(path)
		const ext = nodePath.extname(resolvedPath)
		const isJson = ext === DEFINITION_FILE_EXTENSION
		const isScript = DEFINITION_SCRIPT_EXTENSIONS.includes(ext)

		if (!isJson && !isScript) {
			return {
				success: false,
				message: `Unsupported file extension: ${ext}. Supported: .json, .js, .mjs, .ts, .mts`,
				id: undefined,
			}
		}

		if (!nodeFs.existsSync(resolvedPath)) {
			return {
				success: false,
				message: `File not found: ${resolvedPath}`,
				id: undefined,
			}
		}

		if (isJson) {
			return this.#importJsonFile(resolvedPath)
		}

		return this.#importScriptFile(resolvedPath)
	}

	/**
	 * Removes stored definitions.
	 *
	 * @remarks
	 * Follows the batch operation pattern:
	 * - `forget()` — removes ALL definitions, returns void
	 * - `forget(id)` — removes ONE definition by id, returns boolean
	 *
	 * If stores are configured, also removes entries from the first writable store.
	 */
	forget(): void
	forget(id: string): boolean
	forget(id?: string): void | boolean {
		if (id === undefined) {
			// Remove all — also remove from writable stores
			if (this.#stores) {
				for (const store of this.#stores.stores()) {
					if (store.writable) {
						for (const defId of this.#definitionMap.keys()) {
							store.remove(defId).catch(() => {})
						}
					}
				}
			}
			this.#definitionMap.clear()
			return
		}
		// Remove one
		const existed = this.#definitionMap.delete(id)
		if (existed && this.#stores) {
			for (const store of this.#stores.stores()) {
				if (store.writable) {
					store.remove(id).catch(() => {})
				}
			}
		}
		return existed
	}

	async execute(
		args: Record<string, unknown>,
	): Promise<
		| ImportResult
		| ReasonResult
		| readonly ReasonResult[]
		| ForgetResult
		| readonly { readonly id: string; readonly name: string; readonly type: string }[]
	> {
		// Handle list as a management operation — return early without reasoning
		if (args['list'] === true) {
			return this.list()
		}

		// Handle forget as a management operation — return early without reasoning
		const forgetArg = args['forget']
		if (forgetArg !== undefined) {
			return this.#handleForget(forgetArg)
		}

		// Handle import as a management operation — return early without reasoning
		const importArg = args['import']
		if (typeof importArg === 'string') {
			return this.import(importArg)
		}

		const definition = this.#resolveDefinition(args)

		// Batch mode — subjects array takes precedence
		const rawSubjects = args['subjects']
		if (rawSubjects !== undefined) {
			const subjects = this.#resolveSubjects(rawSubjects)
			const results = this.#reason.reason(subjects, definition)
			await this.#handleStorage(args, definition)
			return results
		}

		// Single mode
		const subject = this.#resolveSubject(args)
		const result = this.#reason.reason(subject, definition)

		// After successful reasoning, handle memory/persist
		await this.#handleStorage(args, definition)

		return result
	}

	async #handleStorage(args: Record<string, unknown>, definition: ReasonDefinition): Promise<void> {
		const persist = args['persist'] === true
		const memory =
			persist || args['memory'] === true || (args['memory'] === undefined && this.#memory)

		// Only store inline definitions (not pre-loaded ones reused by id)
		const isInline = args['definition'] !== undefined

		if (isInline && memory) {
			this.#definitionMap.set(definition.id, definition)
		}

		if (isInline && persist && this.#stores) {
			await this.#stores.write({
				id: definition.id,
				data: toRecord(definition),
			})
		}
	}

	#resolveSubject(args: Record<string, unknown>): Subject {
		const raw = args['subject']
		if (raw === undefined || raw === null) {
			return {}
		}
		if (!isSubject(raw)) {
			throw createReasonError(
				'INVALID_DEFINITION',
				`Invalid subject: expected an object, got ${typeof raw}`,
			)
		}
		return raw
	}

	#resolveSubjects(raw: unknown): Subject[] {
		if (!Array.isArray(raw)) {
			throw createReasonError(
				'INVALID_DEFINITION',
				`Invalid subjects: expected an array, got ${typeof raw}`,
			)
		}
		const subjects: Subject[] = []
		for (let i = 0; i < raw.length; i++) {
			const item = raw[i]
			if (!isSubject(item)) {
				throw createReasonError(
					'INVALID_DEFINITION',
					`Invalid subject at index ${i}: expected an object, got ${typeof item}`,
				)
			}
			subjects.push(item)
		}
		return subjects
	}

	#resolveDefinition(args: Record<string, unknown>): ReasonDefinition {
		// Inline definition takes precedence
		const inlineDef = args['definition']
		if (inlineDef !== undefined) {
			if (!isObject(inlineDef)) {
				throw createReasonError(
					'INVALID_DEFINITION',
					`Invalid definition: expected an object, got ${typeof inlineDef}`,
				)
			}

			const type = prop(inlineDef, 'type')
			if (typeof type !== 'string') {
				throw createReasonError(
					'INVALID_DEFINITION',
					'Invalid definition: missing required "type" field. Must be one of: quantitative, logical, symbolic, inferential',
				)
			}

			if (!isReasonDefinition(inlineDef)) {
				throw createReasonError(
					'INVALID_DEFINITION',
					`Invalid definition type: "${type}". Must be one of: quantitative, logical, symbolic, inferential`,
				)
			}

			const id = prop(inlineDef, 'id')
			const name = prop(inlineDef, 'name')
			const problems: string[] = []
			if (typeof id !== 'string' || id.length === 0) {
				problems.push('"id" (string) is required')
			}
			if (typeof name !== 'string' || name.length === 0) {
				problems.push('"name" (string) is required')
			}
			if (problems.length > 0) {
				throw createReasonError(
					'INVALID_DEFINITION',
					`Invalid ${type} definition: ${problems.join('; ')}`,
				)
			}

			return inlineDef
		}

		// Fall back to pre-loaded definition by id
		const defId = args['definitionId']
		if (typeof defId === 'string') {
			const found = this.#definitionMap.get(defId)
			if (found) {
				return found
			}
			const available = [...this.#definitionMap.keys()]
			const hint =
				available.length > 0
					? ` Available IDs: ${available.join(', ')}`
					: ' No definitions are pre-loaded.'
			throw createReasonError('INVALID_DEFINITION', `Definition not found: "${defId}".${hint}`)
		}

		throw createReasonError(
			'INVALID_DEFINITION',
			'No definition provided. Pass "definition" (inline object) or "definitionId" (string referencing a pre-loaded definition).',
		)
	}

	#handleForget(forgetArg: unknown): ForgetResult {
		if (forgetArg === true) {
			const count = this.#definitionMap.size
			this.forget()
			return { success: true, message: `Removed all ${count} stored definition(s).` }
		}
		if (typeof forgetArg === 'string') {
			const removed = this.forget(forgetArg)
			return {
				success: removed,
				message: removed
					? `Removed definition "${forgetArg}".`
					: `Definition "${forgetArg}" not found.`,
			}
		}
		throw createReasonError(
			'INVALID_DEFINITION',
			'Invalid "forget" value. Pass a definition id (string) to remove one, or true to remove all.',
		)
	}

	async #importJsonFile(filePath: string): Promise<ImportResult> {
		let raw: string
		try {
			raw = nodeFs.readFileSync(filePath, 'utf8')
		} catch {
			return { success: false, message: `Cannot read: ${filePath}`, id: undefined }
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			return { success: false, message: `Invalid JSON: ${filePath}`, id: undefined }
		}

		if (!isReasonDefinition(parsed)) {
			return {
				success: false,
				message: `Not a valid reason definition: ${filePath}`,
				id: undefined,
			}
		}

		const id = prop(parsed, 'id')
		if (typeof id !== 'string' || id.length === 0) {
			return { success: false, message: `Missing id in definition: ${filePath}`, id: undefined }
		}

		this.#definitionMap.set(id, parsed)

		if (this.#stores) {
			await this.#stores.write({ id, data: toRecord(parsed) })
		}

		return { success: true, message: `Imported definition "${id}" from ${filePath}`, id }
	}

	async #importScriptFile(filePath: string): Promise<ImportResult> {
		const fileUrl = pathToFileURL(filePath).href
		try {
			const module: unknown = await import(fileUrl)

			const defaultExport = prop(module, 'default')
			if (defaultExport === undefined) {
				return { success: false, message: `No default export: ${filePath}`, id: undefined }
			}

			const resolved = resolveDefinitionModule(defaultExport)
			if (!resolved) {
				return {
					success: false,
					message: `Default export is not a valid definition: ${filePath}`,
					id: undefined,
				}
			}

			const id = resolved.id
			this.#definitionMap.set(id, resolved)

			if (this.#stores) {
				await this.#stores.write({ id, data: toRecord(resolved) })
			}

			return { success: true, message: `Imported definition "${id}" from ${filePath}`, id }
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return { success: false, message: `Import failed: ${filePath} — ${message}`, id: undefined }
		}
	}
}
