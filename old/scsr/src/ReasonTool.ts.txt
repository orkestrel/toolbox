import type {
	DefinitionImportHandler,
	ForgetResult,
	ImportResult,
	JsonSchemaObject,
	MCPStoreManagerInterface,
	ReasonDefinition,
	ReasonInterface,
	ReasonResult,
	ReasonToolInput,
	ReasonToolInterface,
	Subject,
} from '../../types.js'
import {
	isObject,
	isReasonDefinition,
	isSubject,
	parseString,
	extractProperty,
	REASON_TOOL_PARAMETERS,
	coerceRecord,
} from '../../index.js'
import { createReasonError } from '../../errors.js'

/**
 * Standard tool wrapping a Reason instance for agent integration.
 *
 * @remarks
 * Resolves a `ReasonDefinition` from either an inline object or a pre-loaded id,
 * then delegates to the underlying `ReasonInterface`.
 */
export class ReasonTool implements ReasonToolInterface {
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	readonly #reason: ReasonInterface
	readonly #definitionMap: Map<string, ReasonDefinition> = new Map()
	readonly #memory: boolean
	readonly #stores: MCPStoreManagerInterface | undefined
	readonly #importHandler: DefinitionImportHandler | undefined

	constructor(input: ReasonToolInput) {
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		this.#reason = input.reason
		this.#memory = input.memory ?? false
		this.#stores = input.stores
		this.#importHandler = input.import

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

	get parameters(): JsonSchemaObject {
		return REASON_TOOL_PARAMETERS
	}

	get stores(): MCPStoreManagerInterface | undefined {
		return this.#stores
	}

	definitions(): ReadonlyMap<string, ReasonDefinition> {
		return new Map(this.#definitionMap)
	}

	list(): readonly { readonly id: string; readonly name: string; readonly type: string }[] {
		return [...this.#definitionMap.values()].map((def) => ({
			id: def.id,
			name: def.name,
			type: def.type,
		}))
	}

	async init(): Promise<void> {
		if (!this.#stores) return

		await this.#stores.load()

		for (const entry of this.#stores.entries()) {
			if (isReasonDefinition(entry.data)) {
				this.#definitionMap.set(entry.id, entry.data)
			}
		}
	}

	async import(path: string): Promise<ImportResult> {
		if (!this.#importHandler) {
			return {
				success: false,
				message:
					'Import not available — no import handler configured. Provide an import handler in ReasonToolInput.',
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
						for (const defId of this.#definitionMap.keys()) {
							store.remove(defId).catch(() => {})
						}
					}
				}
			}
			this.#definitionMap.clear()
			return
		}
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
		args: Readonly<Record<string, unknown>>,
	): Promise<
		| ImportResult
		| ReasonResult
		| readonly ReasonResult[]
		| ForgetResult
		| readonly { readonly id: string; readonly name: string; readonly type: string }[]
	> {
		if (args['list'] === true) {
			return this.list()
		}

		const forgetArg = args['forget']
		if (forgetArg !== undefined) {
			return this.#handleForget(forgetArg)
		}

		const importArg = parseString(args['import'])
		if (importArg !== undefined) {
			return this.import(importArg)
		}

		const definition = this.#resolveDefinition(args)

		const rawSubjects = args['subjects']
		if (rawSubjects !== undefined) {
			const subjects = this.#resolveSubjects(rawSubjects)
			const results = this.#reason.reason(subjects, definition)
			await this.#handleStorage(args, definition)
			return results
		}

		const subject = this.#resolveSubject(args)
		const result = this.#reason.reason(subject, definition)

		await this.#handleStorage(args, definition)

		return result
	}

	/**
	 * Registers a definition in the in-memory map.
	 * Used by import handlers to inject definitions after successful import.
	 */
	register(id: string, definition: ReasonDefinition): void {
		this.#definitionMap.set(id, definition)
	}

	/**
	 * Persists a definition to the configured store manager.
	 * Used by import handlers to persist after successful import.
	 */
	async persist(id: string, definition: ReasonDefinition): Promise<void> {
		if (this.#stores) {
			await this.#stores.write({ id, data: coerceRecord(definition) })
		}
	}

	async #handleStorage(
		args: Readonly<Record<string, unknown>>,
		definition: ReasonDefinition,
	): Promise<void> {
		const persist = args['persist'] === true
		const memory =
			persist || args['memory'] === true || (args['memory'] === undefined && this.#memory)
		const isInline = args['definition'] !== undefined

		if (isInline && memory) {
			this.#definitionMap.set(definition.id, definition)
		}

		if (isInline && persist && this.#stores) {
			await this.#stores.write({
				id: definition.id,
				data: coerceRecord(definition),
			})
		}
	}

	#resolveSubject(args: Readonly<Record<string, unknown>>): Subject {
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
			const item: unknown = raw[i]
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

	#resolveDefinition(args: Readonly<Record<string, unknown>>): ReasonDefinition {
		const inlineDef = args['definition']
		if (inlineDef !== undefined) {
			if (!isObject(inlineDef)) {
				throw createReasonError(
					'INVALID_DEFINITION',
					`Invalid definition: expected an object, got ${typeof inlineDef}`,
				)
			}

			const type = extractProperty(inlineDef, 'type')
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

			const id = extractProperty(inlineDef, 'id')
			const name = extractProperty(inlineDef, 'name')
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

		const defId = parseString(args['definitionId'])
		if (defId !== undefined) {
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
}
