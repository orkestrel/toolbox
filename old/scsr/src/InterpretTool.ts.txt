import type {
	DefinitionImportHandler,
	ImportResult,
	InterpretInterface,
	InterpretResult,
	InterpretTemplate,
	InterpretToolInput,
	InterpretToolInterface,
	JsonSchemaObject,
	MCPStoreManagerInterface,
} from '../../types.js'
import {
	INTERPRET_TOOL_PARAMETERS,
	isInterpretTemplate,
	isReasonDefinition,
	isRecord,
	isSubject,
	parseString,
} from '../../index.js'

/**
 * Standard tool wrapping an InterpretInterface for agent/MCP integration.
 *
 * @remarks
 * Dispatches operations based on `args.operation` and returns structured results.
 * Supports template persistence, import, and forget.
 */
export class InterpretTool implements InterpretToolInterface {
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	readonly #interpreter: InterpretInterface
	readonly #pendingTemplates: InterpretTemplate[]
	readonly #memory: boolean
	readonly #stores: MCPStoreManagerInterface | undefined
	readonly #importHandler: DefinitionImportHandler | undefined

	constructor(input: InterpretToolInput) {
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		this.#interpreter = input.interpreter
		this.#pendingTemplates = input.templates ? [...input.templates] : []
		this.#memory = input.memory ?? false
		this.#stores = input.stores
		this.#importHandler = input.import
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

	get parameters(): JsonSchemaObject {
		return INTERPRET_TOOL_PARAMETERS
	}

	get stores(): MCPStoreManagerInterface | undefined {
		return this.#stores
	}

	async init(): Promise<void> {
		for (const template of this.#pendingTemplates) {
			this.#interpreter.register(template)
		}
		this.#pendingTemplates.length = 0

		if (this.#stores) {
			await this.#stores.load()
			for (const entry of this.#stores.entries()) {
				if (isInterpretTemplate(entry.data)) {
					this.#interpreter.register(entry.data)
				}
			}
		}
	}

	templates(): ReadonlyMap<string, InterpretTemplate> {
		const map = new Map<string, InterpretTemplate>()
		for (const template of this.#interpreter.templates()) {
			map.set(template.id, template)
		}
		return map
	}

	list(): readonly { readonly id: string; readonly name: string; readonly domain: string }[] {
		return this.#interpreter.templates().map((t) => ({
			id: t.id,
			name: t.name,
			domain: t.domain,
		}))
	}

	async import(path: string): Promise<ImportResult> {
		if (!this.#importHandler) {
			return {
				success: false,
				message:
					'Import not available — no import handler configured. Provide an import handler in InterpretToolInput.',
				id: undefined,
			}
		}

		return this.#importHandler(path)
	}

	forget(): void
	forget(id: string): boolean
	forget(id?: string): void | boolean {
		if (id === undefined) {
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
		if (this.#stores) {
			for (const store of this.#stores.stores()) {
				if (store.writable) {
					store.remove(id)
				}
			}
		}
		return this.#interpreter.unregister(id)
	}

	async execute(args: Readonly<Record<string, unknown>>): Promise<unknown> {
		const forgetArg = args['forget']
		if (forgetArg !== undefined) {
			return this.#handleForget(forgetArg)
		}

		const importArg = parseString(args['import'])
		if (importArg !== undefined) {
			return this.import(importArg)
		}

		const operation = parseString(args['operation'])
		if (operation === undefined) {
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

	/**
	 * Registers a template in the interpreter.
	 * Used by import handlers to inject templates after successful import.
	 */
	register(template: InterpretTemplate): void {
		this.#interpreter.register(template)
	}

	/**
	 * Persists a template to the configured store manager.
	 * Used by import handlers to persist after successful import.
	 */
	async persist(template: InterpretTemplate): Promise<void> {
		if (!this.#memory || !this.#stores) return

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
			})),
			definition: template.definition,
		}
		await this.#stores.write({ id: template.id, data: serializable })
	}

	async #handleInterpret(
		args: Readonly<Record<string, unknown>>,
	): Promise<InterpretResult | { readonly error: string }> {
		const input = parseString(args['input'])
		if (input === undefined) {
			return { error: 'Missing or empty "input" for interpret operation.' }
		}

		try {
			return await this.#interpreter.interpret(input)
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return { error: `Interpret failed: ${message}` }
		}
	}

	#handleDescribe(args: Readonly<Record<string, unknown>>): { readonly error: string } | unknown {
		const rawSubject = args['subject']
		const rawDefinition = args['definition']

		if (!isRecord(rawSubject) || !isSubject(rawSubject)) {
			return {
				error: 'Missing or invalid "subject" for describe operation. Expected a plain object.',
			}
		}

		if (!isRecord(rawDefinition) || !isReasonDefinition(rawDefinition)) {
			return {
				error:
					'Missing or invalid "definition" for describe operation. Expected a valid ReasonDefinition.',
			}
		}

		try {
			return this.#interpreter.describe(rawSubject, rawDefinition)
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return { error: `Describe failed: ${message}` }
		}
	}

	#handleNormalize(args: Readonly<Record<string, unknown>>): unknown {
		const input = parseString(args['input'])
		if (input === undefined) {
			return { error: 'Missing or empty "input" for normalize operation.' }
		}

		try {
			return this.#interpreter.normalize(input)
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return { error: `Normalize failed: ${message}` }
		}
	}

	#handleParse(args: Readonly<Record<string, unknown>>): unknown {
		const input = parseString(args['input'])
		if (input === undefined) {
			return { error: 'Missing or empty "input" for parse operation.' }
		}

		try {
			return this.#interpreter.parse(input)
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return { error: `Parse failed: ${message}` }
		}
	}

	#handleTemplates(): unknown {
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
}
