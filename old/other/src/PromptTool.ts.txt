import type {
	MCPStoreManagerInterface,
	PromptOperation,
	PromptToolInput,
	PromptToolInterface,
	PromptToolRemote,
	PromptToolResult,
} from '../types.js'
import type {
	PromptType,
	TerminalFormInterface,
	ValidationResult,
	ValidationRules,
} from '@orkestrel/terminal'
import { isPromptType, validateInput } from '@orkestrel/terminal'
import type { PromptTemplate, TemplateInterface, TemplateManagerInterface } from '@orkestrel/prompt'
import { isPromptTemplate, TemplateManager } from '@orkestrel/prompt'
import { isRecord } from '@orkestrel/core'
import { PROMPT_TOOL_PARAMETERS } from '../constants.js'

/**
 * Standard tool wrapping interactive terminal prompts and template management
 * for agent/MCP integration.
 *
 * @remarks
 * Dispatches prompt operations (input, password, confirm, select, checkbox,
 * editor) to a PromptInterface, and template operations (register, fill,
 * validate, templates, remove) to a TemplateManagerInterface.
 *
 * When `stores` is provided, templates are persisted to disk and loaded
 * on `init()`.
 */
export class PromptTool implements PromptToolInterface {
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	readonly #terminal: TerminalFormInterface
	readonly #templates: TemplateManagerInterface
	readonly #stores: MCPStoreManagerInterface | undefined
	readonly #remote: PromptToolRemote | undefined

	constructor(input: PromptToolInput) {
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		this.#terminal = input.terminal
		this.#templates = input.templates ?? new TemplateManager()
		this.#stores = input.stores
		this.#remote = input.remote
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
		return PROMPT_TOOL_PARAMETERS
	}

	get stores(): MCPStoreManagerInterface | undefined {
		return this.#stores
	}

	/**
	 * Loads persisted prompt templates from configured stores.
	 *
	 * @remarks
	 * Call after construction to load templates from stores on disk.
	 */
	async init(): Promise<void> {
		if (this.#stores) {
			await this.#stores.load()
			for (const entry of this.#stores.entries()) {
				if (isPromptTemplate(entry.data)) {
					this.#templates.register(entry.data)
				}
			}
		}
	}

	template(id: string): TemplateInterface | undefined {
		return this.#templates.template(id)
	}

	templates(): readonly TemplateInterface[] {
		return this.#templates.templates()
	}

	/**
	 * Removes registered prompt templates.
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
			if (this.#stores) {
				for (const store of this.#stores.stores()) {
					if (store.writable) {
						for (const template of this.#templates.templates()) {
							store.remove(template.id)
						}
					}
				}
			}
			this.#templates.clear()
			return
		}
		if (this.#stores) {
			for (const store of this.#stores.stores()) {
				if (store.writable) {
					store.remove(id)
				}
			}
		}
		return this.#templates.remove(id)
	}

	async execute(args: Record<string, unknown>): Promise<PromptToolResult> {
		const start = performance.now()
		const operation = args.operation

		if (typeof operation !== 'string') {
			return this.#error('input', 'Missing required field: operation', start)
		}

		try {
			switch (operation) {
				case 'input':
					return await this.#handleInput(args, start)
				case 'password':
					return await this.#handlePassword(args, start)
				case 'confirm':
					return await this.#handleConfirm(args, start)
				case 'select':
					return await this.#handleSelect(args, start)
				case 'checkbox':
					return await this.#handleCheckbox(args, start)
				case 'editor':
					return await this.#handleEditor(args, start)
				case 'form':
					return await this.#handleForm(args, start)
				case 'register':
					return await this.#handleRegister(args, start)
				case 'fill':
					return this.#handleFill(args, start)
				case 'validate':
					return this.#handleValidate(args, start)
				case 'templates':
					return this.#handleTemplates(start)
				case 'remove':
					return this.#handleRemove(args, start)
				case 'launch':
					return this.#handleLaunch(start)
				case 'status':
					return this.#handleStatus(start)
				default:
					return this.#error(this.#toOperation(operation), `Unknown operation: ${operation}`, start)
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error)
			return this.#error(this.#toOperation(operation), message, start)
		}
	}

	// === Prompt Operations

	async #handleInput(args: Record<string, unknown>, start: number): Promise<PromptToolResult> {
		const message = args.message
		if (typeof message !== 'string') {
			return this.#error('input', 'Missing required field: message', start)
		}

		const value = typeof args.default === 'string' ? args.default : undefined
		const rules = this.#resolveValidationRules(args.validate)
		const result = await this.#terminal.input({ message, default: value, validate: rules })
		return this.#withValidation('input', result, rules, start)
	}

	async #handlePassword(args: Record<string, unknown>, start: number): Promise<PromptToolResult> {
		const message = args.message
		if (typeof message !== 'string') {
			return this.#error('password', 'Missing required field: message', start)
		}

		const mask = typeof args.mask === 'string' ? args.mask : undefined
		const rules = this.#resolveValidationRules(args.validate)
		const result = await this.#terminal.password({ message, mask, validate: rules })
		return this.#withValidation('password', result, rules, start)
	}

	async #handleConfirm(args: Record<string, unknown>, start: number): Promise<PromptToolResult> {
		const message = args.message
		if (typeof message !== 'string') {
			return this.#error('confirm', 'Missing required field: message', start)
		}

		const value = typeof args.default === 'boolean' ? args.default : undefined
		const result = await this.#terminal.confirm({ message, default: value })
		return this.#success('confirm', result, start)
	}

	async #handleSelect(args: Record<string, unknown>, start: number): Promise<PromptToolResult> {
		const message = args.message
		if (typeof message !== 'string') {
			return this.#error('select', 'Missing required field: message', start)
		}

		const choices = args.choices
		if (!Array.isArray(choices) || choices.length === 0) {
			return this.#error('select', 'Missing or empty required field: choices', start)
		}

		const normalizedChoices = this.#normalizeChoices(choices)
		const value = typeof args.default === 'string' ? args.default : undefined
		const result = await this.#terminal.select({
			message,
			choices: normalizedChoices,
			default: value,
		})
		return this.#success('select', result, start)
	}

	async #handleCheckbox(args: Record<string, unknown>, start: number): Promise<PromptToolResult> {
		const message = args.message
		if (typeof message !== 'string') {
			return this.#error('checkbox', 'Missing required field: message', start)
		}

		const choices = args.choices
		if (!Array.isArray(choices) || choices.length === 0) {
			return this.#error('checkbox', 'Missing or empty required field: choices', start)
		}

		const normalizedChoices = this.#normalizeChoices(choices)
		const min = typeof args.min === 'number' ? args.min : undefined
		const max = typeof args.max === 'number' ? args.max : undefined
		const result = await this.#terminal.checkbox({ message, choices: normalizedChoices, min, max })
		return this.#success('checkbox', result, start)
	}

	async #handleEditor(args: Record<string, unknown>, start: number): Promise<PromptToolResult> {
		const message = args.message
		if (typeof message !== 'string') {
			return this.#error('editor', 'Missing required field: message', start)
		}

		const value = typeof args.default === 'string' ? args.default : undefined
		const rules = this.#resolveValidationRules(args.validate)
		const result = await this.#terminal.editor({ message, default: value, validate: rules })
		return this.#withValidation('editor', result, rules, start)
	}

	// === Form Operations

	async #handleForm(args: Record<string, unknown>, start: number): Promise<PromptToolResult> {
		const fields = args.fields
		if (!Array.isArray(fields) || fields.length === 0) {
			return this.#error('form', 'Missing or empty required field: fields', start)
		}

		const result: Record<string, unknown> = {}

		for (const field of fields) {
			if (!isRecord(field)) continue
			const name = field.name
			const type = field.type
			const message = field.message
			if (typeof name !== 'string' || typeof type !== 'string' || typeof message !== 'string') {
				return this.#error(
					'form',
					`Invalid field: name, type, and message are required strings`,
					start,
				)
			}
			if (!isPromptType(type)) {
				return this.#error('form', `Invalid field type: ${type}`, start)
			}

			result[name] = await this.#dispatchFormField(type, field)
		}

		return this.#success('form', result, start)
	}

	async #dispatchFormField(type: PromptType, field: Record<string, unknown>): Promise<unknown> {
		const message = field.message as string
		switch (type) {
			case 'input': {
				const defaultValue = typeof field.default === 'string' ? field.default : undefined
				const rules = this.#resolveValidationRules(field.validate)
				return this.#terminal.input({ message, default: defaultValue, validate: rules })
			}
			case 'password': {
				const mask = typeof field.mask === 'string' ? field.mask : undefined
				const rules = this.#resolveValidationRules(field.validate)
				return this.#terminal.password({ message, mask, validate: rules })
			}
			case 'confirm': {
				const defaultValue = typeof field.default === 'boolean' ? field.default : undefined
				return this.#terminal.confirm({ message, default: defaultValue })
			}
			case 'select': {
				const choices = Array.isArray(field.choices) ? this.#normalizeChoices(field.choices) : []
				const defaultValue = typeof field.default === 'string' ? field.default : undefined
				return this.#terminal.select({ message, choices, default: defaultValue })
			}
			case 'checkbox': {
				const choices = Array.isArray(field.choices) ? this.#normalizeChoices(field.choices) : []
				const min = typeof field.min === 'number' ? field.min : undefined
				const max = typeof field.max === 'number' ? field.max : undefined
				return this.#terminal.checkbox({ message, choices, min, max })
			}
			case 'editor': {
				const defaultValue = typeof field.default === 'string' ? field.default : undefined
				const rules = this.#resolveValidationRules(field.validate)
				return this.#terminal.editor({ message, default: defaultValue, validate: rules })
			}
		}
	}

	// === Template Operations

	async #handleRegister(args: Record<string, unknown>, start: number): Promise<PromptToolResult> {
		const templateArg = args.template
		if (!isRecord(templateArg) || !isPromptTemplate(templateArg)) {
			return this.#error('register', 'Missing or invalid required field: template', start)
		}

		this.#templates.register(templateArg)
		await this.#persistTemplate(templateArg)
		return this.#success('register', { id: templateArg.id, registered: true }, start)
	}

	#handleFill(args: Record<string, unknown>, start: number): PromptToolResult {
		const id = args.id
		if (typeof id !== 'string') {
			return this.#error('fill', 'Missing required field: id', start)
		}

		const values = isRecord(args.values) ? this.#toStringRecord(args.values) : {}
		const filled = this.#templates.fill(id, values)
		return this.#success('fill', filled, start)
	}

	#handleValidate(args: Record<string, unknown>, start: number): PromptToolResult {
		const id = args.id
		if (typeof id !== 'string') {
			return this.#error('validate', 'Missing required field: id', start)
		}

		const values = isRecord(args.values) ? this.#toStringRecord(args.values) : {}
		const result = this.#templates.validate(id, values)
		return this.#success('validate', result, start)
	}

	#handleTemplates(start: number): PromptToolResult {
		const templates = this.#templates.templates().map((t) => ({
			id: t.id,
			name: t.name,
			summary: t.summary,
			category: t.category,
			tags: t.tags,
			placeholders: t.placeholders.map((p) => p.name),
		}))
		return this.#success('templates', templates, start)
	}

	#handleRemove(args: Record<string, unknown>, start: number): PromptToolResult {
		const id = args.id
		if (typeof id !== 'string') {
			return this.#error('remove', 'Missing required field: id', start)
		}

		const removed = this.#templates.remove(id)
		return this.#success('remove', { id, removed }, start)
	}

	#handleLaunch(start: number): PromptToolResult {
		if (this.#remote === undefined) {
			return this.#error('launch', 'Remote prompt bridge is not configured', start)
		}

		if (this.#remote.connected()) {
			return this.#success(
				'launch',
				{
					launched: false,
					reason: 'Prompt companion is already connected',
					connected: true,
				},
				start,
			)
		}

		const launched = this.#remote.launch()
		return this.#success(
			'launch',
			{
				launched,
				connected: this.#remote.connected(),
				reason: launched
					? 'Prompt companion launched in a new terminal'
					: 'Failed to launch prompt companion',
			},
			start,
		)
	}

	#handleStatus(start: number): PromptToolResult {
		if (this.#remote === undefined) {
			return this.#success(
				'status',
				{
					remote: false,
					connected: false,
					message: 'Remote prompt bridge is not configured. Prompts are handled locally.',
				},
				start,
			)
		}

		const connected = this.#remote.connected()
		const commandPrefix = this.#remote.sealed ? this.#remote.script : `node ${this.#remote.script}`
		return this.#success(
			'status',
			{
				remote: true,
				connected,
				port: this.#remote.port,
				command: `${commandPrefix} --companion --port ${this.#remote.port} --token ${this.#remote.token}`,
				message: connected
					? 'Prompt companion is connected and ready'
					: 'Prompt companion is not connected. Run the command above in the IDE terminal to connect, or use the launch operation as a fallback.',
			},
			start,
		)
	}

	// === Private Helpers

	#normalizeChoices(
		choices: unknown[],
	): (string | { name: string; value: string; description?: string; checked?: boolean })[] {
		return choices.map((choice) => {
			if (typeof choice === 'string') return choice
			if (isRecord(choice) && typeof choice.name === 'string' && typeof choice.value === 'string') {
				const normalized: { name: string; value: string; description?: string; checked?: boolean } =
					{
						name: choice.name,
						value: choice.value,
					}
				if (typeof choice.description === 'string') normalized.description = choice.description
				if (typeof choice.checked === 'boolean') normalized.checked = choice.checked
				return normalized
			}
			return String(choice)
		})
	}

	#toStringRecord(record: Record<string, unknown>): Record<string, string> {
		const result: Record<string, string> = {}
		for (const [key, value] of Object.entries(record)) {
			if (typeof value === 'string') {
				result[key] = value
			}
		}
		return result
	}

	#resolveValidationRules(value: unknown): ValidationRules | undefined {
		if (!isRecord(value)) return undefined

		const rules: {
			required?: boolean
			minimum?: number
			maximum?: number
			pattern?: string
			email?: boolean
			url?: boolean
			numeric?: boolean
			integer?: boolean
			alphanumeric?: boolean
		} = {}

		if (typeof value.required === 'boolean') rules.required = value.required
		if (typeof value.minimum === 'number') rules.minimum = value.minimum
		if (typeof value.maximum === 'number') rules.maximum = value.maximum
		if (typeof value.pattern === 'string') rules.pattern = value.pattern
		if (typeof value.email === 'boolean') rules.email = value.email
		if (typeof value.url === 'boolean') rules.url = value.url
		if (typeof value.numeric === 'boolean') rules.numeric = value.numeric
		if (typeof value.integer === 'boolean') rules.integer = value.integer
		if (typeof value.alphanumeric === 'boolean') rules.alphanumeric = value.alphanumeric

		if (Object.keys(rules).length === 0) return undefined
		return rules
	}

	#withValidation(
		operation: PromptOperation,
		result: string,
		rules: ValidationRules | undefined,
		start: number,
	): PromptToolResult {
		if (rules !== undefined && result === '') {
			const validation = validateInput(result, rules)
			if (!validation.valid) {
				return this.#validationError(operation, validation, start)
			}
		}
		return this.#success(operation, result, start)
	}

	#validationError(
		operation: PromptOperation,
		validation: ValidationResult,
		start: number,
	): PromptToolResult {
		const messages = validation.errors.map((e) => e.message)
		return {
			operation,
			ok: false,
			output: validation,
			error: `Validation failed: ${messages.join('; ')}`,
			duration: performance.now() - start,
		}
	}

	#success(operation: PromptOperation, output: unknown, start: number): PromptToolResult {
		return {
			operation,
			ok: true,
			output,
			error: undefined,
			duration: performance.now() - start,
		}
	}

	#error(operation: PromptOperation, message: string, start: number): PromptToolResult {
		return {
			operation,
			ok: false,
			output: undefined,
			error: message,
			duration: performance.now() - start,
		}
	}

	#toOperation(value: string): PromptOperation {
		const operations: Record<string, PromptOperation> = {
			input: 'input',
			password: 'password',
			confirm: 'confirm',
			select: 'select',
			checkbox: 'checkbox',
			editor: 'editor',
			form: 'form',
			register: 'register',
			fill: 'fill',
			validate: 'validate',
			templates: 'templates',
			remove: 'remove',
			launch: 'launch',
			status: 'status',
		}
		return operations[value] ?? 'input'
	}

	async #persistTemplate(template: PromptTemplate): Promise<void> {
		if (!this.#stores) return
		const serializable: Record<string, unknown> = {
			id: template.id,
			name: template.name,
			content: template.content,
			placeholders: template.placeholders.map((p) => ({
				name: p.name,
				required: p.required,
				value: p.value,
				description: p.description,
			})),
		}
		if (template.summary !== undefined) serializable.summary = template.summary
		if (template.description !== undefined) serializable.description = template.description
		if (template.category !== undefined) serializable.category = template.category
		if (template.tags !== undefined) serializable.tags = [...template.tags]
		await this.#stores.write({ id: template.id, data: serializable })
	}
}
