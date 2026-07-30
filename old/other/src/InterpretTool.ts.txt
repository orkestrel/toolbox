import type {
	ImportResult,
	InterpretToolInput,
	InterpretToolInterface,
	MCPStoreManagerInterface,
} from '../types.js'
import type { InterpretInterface, InterpretTemplate, InterpretResult } from '@orkestrel/interpret'
import { isReasonDefinition, isSubject } from '@orkestrel/reason'
import { isRecord, prop } from '@orkestrel/core'
import { isInterpretTemplate } from '@orkestrel/interpret'
import {
	INTERPRET_TOOL_PARAMETERS,
	DEFINITION_FILE_EXTENSION,
	DEFINITION_SCRIPT_EXTENSIONS,
} from '../constants.js'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * InterpretTool
 *
 * Standard tool wrapping an InterpretInterface for agent/MCP integration.
 * Dispatches operations based on `args.operation` and returns structured results.
 *
 * Supports template persistence following the same pattern as ReasonTool
 * with definitions — templates can be stored in memory, persisted to
 * `.orkestrel/templates/`, imported from files, and forgotten.
 */
export class InterpretTool implements InterpretToolInterface {
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	readonly #interpreter: InterpretInterface
	readonly #pendingTemplates: InterpretTemplate[]
	readonly #memory: boolean
	readonly #stores: MCPStoreManagerInterface | undefined

	constructor(input: InterpretToolInput) {
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		this.#interpreter = input.interpreter
		this.#pendingTemplates = input.templates ? [...input.templates] : []
		this.#memory = input.memory ?? false
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
		return INTERPRET_TOOL_PARAMETERS
	}

	get stores(): MCPStoreManagerInterface | undefined {
		return this.#stores
	}

	/**
	 * Registers pending templates and loads templates from stores.
	 *
	 * @remarks
	 * Call after construction to register any templates provided in the input
	 * and to load templates from configured stores on disk.
	 */
	async init(): Promise<void> {
		for (const template of this.#pendingTemplates) {
			this.#interpreter.register(template)
		}
		this.#pendingTemplates.length = 0

		// Load templates from stores
		if (this.#stores) {
			await this.#stores.load()
			for (const entry of this.#stores.entries()) {
				if (isInterpretTemplate(entry.data)) {
					// Type guard narrows entry.data — safe to register directly
					this.#interpreter.register(entry.data)
				}
			}
		}
	}

	/**
	 * Returns a snapshot of all registered templates by id.
	 *
	 * @returns A read-only map of template id to template
	 */
	templates(): ReadonlyMap<string, InterpretTemplate> {
		const map = new Map<string, InterpretTemplate>()
		for (const template of this.#interpreter.templates()) {
			map.set(template.id, template)
		}
		return map
	}

	/**
	 * Returns a summary of all registered templates.
	 *
	 * @returns an array of template summaries with id, name, and domain
	 */
	list(): readonly { readonly id: string; readonly name: string; readonly domain: string }[] {
		return this.#interpreter.templates().map((t) => ({
			id: t.id,
			name: t.name,
			domain: t.domain,
		}))
	}

	/**
	 * Imports a template from a file path and registers it.
	 *
	 * @remarks
	 * Supports `.json`, `.js`, `.mjs`, `.ts`, and `.mts` files.
	 * JSON files are parsed directly. Script files are loaded via dynamic `import()`.
	 * If stores are configured, the template is also persisted to the writable store.
	 *
	 * @param path - absolute or relative path to the template file
	 * @returns result indicating success/failure, message, and the imported template id
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
			return await this.#importJsonTemplate(resolvedPath)
		}

		return this.#importScriptTemplate(resolvedPath)
	}

	/**
	 * Removes registered templates.
	 *
	 * @remarks
	 * Follows the batch operation pattern:
	 * - `forget()` — removes ALL templates
	 * - `forget(id)` — removes ONE template by id, returns boolean
	 */
	forget(): void
	forget(id: string): boolean
	forget(id?: string): void | boolean {
		if (id === undefined) {
			// Remove all from stores
			if (this.#stores) {
				for (const store of this.#stores.stores()) {
					if (store.writable) {
						for (const template of this.#interpreter.templates()) {
							store.remove(template.id)
						}
					}
				}
			}
			this.#interpreter.unregister()
			return
		}
		// Remove one from stores
		if (this.#stores) {
			for (const store of this.#stores.stores()) {
				if (store.writable) {
					store.remove(id)
				}
			}
		}
		return this.#interpreter.unregister(id)
	}

	async execute(args: Record<string, unknown>): Promise<unknown> {
		const operation = args['operation']

		// Handle forget as a management operation
		const forgetArg = args['forget']
		if (forgetArg !== undefined) {
			return this.#handleForget(forgetArg)
		}

		// Handle import as a management operation
		const importArg = args['import']
		if (typeof importArg === 'string') {
			return this.import(importArg)
		}

		if (typeof operation !== 'string') {
			return {
				error:
					'Missing or invalid "operation". Expected one of: interpret, describe, normalize, parse, templates',
			}
		}

		switch (operation) {
			case 'interpret':
				return this.#handleInterpret(args)
			case 'describe':
				return this.#handleDescribe(args)
			case 'normalize':
				return this.#handleNormalize(args)
			case 'parse':
				return this.#handleParse(args)
			case 'templates':
				return this.#handleTemplates()
			default:
				return {
					error: `Unknown operation: "${operation}". Expected one of: interpret, describe, normalize, parse, templates`,
				}
		}
	}

	// === Private Helpers

	async #handleInterpret(
		args: Record<string, unknown>,
	): Promise<InterpretResult | { readonly error: string }> {
		const input = args['input']
		if (typeof input !== 'string' || input.length === 0) {
			return { error: 'Missing or empty "input" for interpret operation.' }
		}

		try {
			return await this.#interpreter.interpret(input)
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return { error: `Interpret failed: ${message}` }
		}
	}

	#handleDescribe(args: Record<string, unknown>):
		| { readonly error: string }
		| {
				readonly prompt: string
				readonly template: string
				readonly entities: number
				readonly duration: number
		  } {
		const rawSubject = args['subject']
		const rawDefinition = args['definition']

		if (!isRecord(rawSubject)) {
			return { error: 'Missing or invalid "subject" for describe operation. Expected an object.' }
		}

		if (!isSubject(rawSubject)) {
			return { error: 'Invalid subject: expected a plain object with string keys.' }
		}

		if (!isRecord(rawDefinition)) {
			return {
				error: 'Missing or invalid "definition" for describe operation. Expected an object.',
			}
		}

		if (!isReasonDefinition(rawDefinition)) {
			return {
				error:
					'Invalid definition: must be a valid ReasonDefinition with "type", "id", and "name".',
			}
		}

		try {
			return this.#interpreter.describe(rawSubject, rawDefinition)
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return { error: `Describe failed: ${message}` }
		}
	}

	#handleNormalize(args: Record<string, unknown>):
		| {
				readonly text: string
				readonly changes: number
				readonly duration: number
		  }
		| { readonly error: string } {
		const input = args['input']
		if (typeof input !== 'string' || input.length === 0) {
			return { error: 'Missing or empty "input" for normalize operation.' }
		}

		try {
			return this.#interpreter.normalize(input)
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return { error: `Normalize failed: ${message}` }
		}
	}

	#handleParse(args: Record<string, unknown>):
		| {
				readonly intent: unknown
				readonly entities: unknown
				readonly complete: boolean
				readonly duration: number
		  }
		| { readonly error: string } {
		const input = args['input']
		if (typeof input !== 'string' || input.length === 0) {
			return { error: 'Missing or empty "input" for parse operation.' }
		}

		try {
			return this.#interpreter.parse(input)
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return { error: `Parse failed: ${message}` }
		}
	}

	#handleTemplates(): {
		readonly templates: readonly {
			readonly id: string
			readonly name: string
			readonly domain: string
		}[]
	} {
		const templates = this.#interpreter.templates()
		return {
			templates: templates.map((t) => ({
				id: t.id,
				name: t.name,
				domain: t.domain,
			})),
		}
	}

	#handleForget(forgetArg: unknown): { readonly success: boolean; readonly message: string } {
		if (forgetArg === true) {
			this.forget()
			return { success: true, message: 'All templates removed.' }
		}
		if (typeof forgetArg === 'string') {
			const existed = this.forget(forgetArg)
			return existed
				? { success: true, message: `Template "${forgetArg}" removed.` }
				: { success: false, message: `Template "${forgetArg}" not found.` }
		}
		return {
			success: false,
			message: 'Invalid "forget" value. Expected true or a template id string.',
		}
	}

	async #importJsonTemplate(resolvedPath: string): Promise<ImportResult> {
		try {
			const raw = nodeFs.readFileSync(resolvedPath, 'utf-8')
			const parsed: unknown = JSON.parse(raw)

			if (!isInterpretTemplate(parsed)) {
				return {
					success: false,
					message: `File does not contain a valid InterpretTemplate: ${resolvedPath}`,
					id: undefined,
				}
			}

			this.#interpreter.register(parsed)
			await this.#persistTemplate(parsed)

			return {
				success: true,
				message: `Template "${parsed.id}" imported from ${resolvedPath}`,
				id: parsed.id,
			}
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return {
				success: false,
				message: `Failed to import template: ${message}`,
				id: undefined,
			}
		}
	}

	async #importScriptTemplate(resolvedPath: string): Promise<ImportResult> {
		try {
			const fileUrl = pathToFileURL(resolvedPath).href
			const module: unknown = await import(fileUrl)

			// Try default export first
			let template: unknown = prop(module, 'default')

			// If default is a function (provider), call it
			if (typeof template === 'function') {
				template = template()
			}

			if (!isInterpretTemplate(template)) {
				return {
					success: false,
					message: `File does not export a valid InterpretTemplate: ${resolvedPath}`,
					id: undefined,
				}
			}

			this.#interpreter.register(template)
			await this.#persistTemplate(template)

			return {
				success: true,
				message: `Template "${template.id}" imported from ${resolvedPath}`,
				id: template.id,
			}
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return {
				success: false,
				message: `Failed to import template: ${message}`,
				id: undefined,
			}
		}
	}

	async #persistTemplate(template: InterpretTemplate): Promise<void> {
		if (!this.#memory || !this.#stores) return

		// Serialize RegExp patterns as source strings for JSON compatibility
		const serializePattern = (p: string | RegExp): string =>
			typeof p === 'string' ? p : `/${p.source}/${p.flags}`

		const serializable: Record<string, unknown> = {
			id: template.id,
			name: template.name,
			domain: template.domain,
			subDomains: template.subDomains?.map(serializePattern),
			intents: [...template.intents],
			mappings: template.mappings.map((m) => ({
				entity: m.entity,
				aliases: m.aliases.map(serializePattern),
				field: m.field,
				required: m.required,
			})),
			defaults: [...template.defaults],
			inferences: template.inferences.map((inf) => ({
				field: inf.field,
				from: [...inf.from],
				// compute functions can't be serialized — omit them
			})),
			definition: template.definition,
		}
		await this.#stores.write({ id: template.id, data: serializable })
	}
}
