import type {
	AgentManagerInterface,
	AgentToolInput,
	AgentToolInterface,
	JsonSchemaObject,
	MessageRole,
	TokenBudgetOptions,
	ToolInterface,
} from '../../types.js'
import {
	AGENT_TOOL_PARAMETERS,
	createAgentManager,
	createOllamaProvider,
	DEFAULT_OLLAMA_URL,
	isAllowedMessageRole,
	isImageMimeType,
	isRecord,
	parseEnum,
	parseString,
	parseStringField,
	resolveTokenBudgetOptions,
} from '../../index.js'

/**
 * Wraps an AgentManager as a tool, enabling sub-agent orchestration.
 *
 * @remarks
 * When invoked, creates a child agent, sends the task as a user message,
 * and returns the generated response. Supports full scope control, timeouts,
 * token budgets, and per-request model selection.
 */
export class AgentTool implements AgentToolInterface {
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	readonly #parameters: JsonSchemaObject
	readonly #manager: AgentManagerInterface
	readonly #tools: readonly ToolInterface[]
	readonly #url: string
	readonly #timeout: number

	constructor(input: AgentToolInput) {
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		this.#parameters = AGENT_TOOL_PARAMETERS
		this.#manager = input.manager
		this.#tools = input.tools !== undefined ? [...input.tools] : []
		this.#url = input.url ?? DEFAULT_OLLAMA_URL
		this.#timeout = input.timeout ?? 120_000
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
		return this.#parameters
	}

	get manager(): AgentManagerInterface {
		return this.#manager
	}

	async execute(args: Readonly<Record<string, unknown>>): Promise<unknown> {
		if (args.models === true) {
			return this.#listModels()
		}

		const task = parseString(args.task)
		const system = parseString(args.system)
		const model = parseString(args.model)

		if (task === undefined) {
			return { error: 'task is required and must be a non-empty string' }
		}

		const manager = model !== undefined ? this.#createManagerForModel(model) : this.#manager

		const agent = manager.create({ system, model })

		if (this.#tools.length > 0) {
			agent.context.tools.add([...this.#tools])
		}

		const instructions = this.#parseInstructions(args.instructions)
		if (instructions.length > 0) {
			agent.context.instructions.add(instructions)
		}

		const documents = this.#parseDocuments(args.documents)
		if (documents.length > 0) {
			agent.context.documents.add(documents)
		}

		const images = this.#parseImages(args.images)
		if (images.length > 0) {
			agent.context.images.add(images)
		}

		const messages = this.#parseMessages(args.messages)
		if (messages.length > 0) {
			agent.context.messages.add(messages)
		}

		const toolNames = this.#parseStringArray(args.tools)
		const scopeConfig = this.#parseScope(args.scope)
		const hasToolScope = toolNames.length > 0 || scopeConfig.tools !== undefined
		const hasScopeConfig =
			scopeConfig.instructions !== undefined ||
			scopeConfig.documents !== undefined ||
			scopeConfig.images !== undefined ||
			scopeConfig.messages !== undefined

		if (hasToolScope || hasScopeConfig) {
			const scopeTools = toolNames.length > 0 ? toolNames : scopeConfig.tools
			agent.context.scope = agent.context.scopes.create({
				name: 'agent-tool-scope',
				tools: scopeTools,
				instructions: scopeConfig.instructions,
				documents: scopeConfig.documents,
				images: scopeConfig.images,
				messages: scopeConfig.messages,
			})
		}

		const timeout = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : undefined
		if (timeout !== undefined) {
			agent.context.timeouts.create(timeout)
		}

		const budget = this.#parseBudget(args.budget)
		if (budget !== undefined) {
			agent.context.budgets.create(resolveTokenBudgetOptions(budget))
		}

		try {
			agent.context.messages.add({ role: 'user', content: task })
			const response = await agent.generate()
			return { response }
		} catch (thrown: unknown) {
			const error = thrown instanceof Error ? thrown.message : String(thrown)
			return { error }
		} finally {
			manager.destroy(agent.id)
		}
	}

	#createManagerForModel(model: string): AgentManagerInterface {
		const provider = createOllamaProvider({
			model,
			url: this.#url,
			think: false,
			timeout: this.#timeout,
		})
		return createAgentManager(provider)
	}

	async #listModels(): Promise<unknown> {
		try {
			const response = await fetch(`${this.#url}/api/tags`)
			if (!response.ok) {
				return { error: `Failed to list models: ${response.status} ${response.statusText}` }
			}
			const data: unknown = await response.json()
			if (!isRecord(data) || !Array.isArray(data.models)) {
				return { error: 'Unexpected response format from provider' }
			}
			const models: { name: string; size: number; modified: string }[] = []
			for (const entry of data.models) {
				if (!isRecord(entry)) continue
				const name = parseStringField(entry, 'name')
				if (name === undefined) continue
				const size = typeof entry.size === 'number' ? entry.size : 0
				const modified = parseStringField(entry, 'modified_at') ?? ''
				models.push({ name, size, modified })
			}
			return { models }
		} catch (thrown: unknown) {
			const error = thrown instanceof Error ? thrown.message : String(thrown)
			return { error: `Failed to list models: ${error}` }
		}
	}

	#parseStringArray(value: unknown): string[] {
		if (!Array.isArray(value)) return []
		const result: string[] = []
		for (const item of value) {
			if (typeof item === 'string' && item.length > 0) {
				result.push(item)
			}
		}
		return result
	}

	#parseMessages(value: unknown): { role: MessageRole; content: string }[] {
		if (!Array.isArray(value)) return []
		const result: { role: MessageRole; content: string }[] = []
		for (const item of value) {
			if (!isRecord(item)) continue
			const role = parseStringField(item, 'role')
			const content = parseStringField(item, 'content')
			if (role === undefined || !isAllowedMessageRole(role) || content === undefined) continue
			result.push({ role, content })
		}
		return result
	}

	#parseScope(value: unknown): {
		instructions: string[] | undefined
		documents: string[] | undefined
		images: string[] | undefined
		tools: string[] | undefined
		messages: string[] | undefined
	} {
		const emptyScope = {
			instructions: undefined,
			documents: undefined,
			images: undefined,
			tools: undefined,
			messages: undefined,
		}
		if (!isRecord(value)) return emptyScope
		const instructions = this.#parseStringArray(value.instructions)
		const documents = this.#parseStringArray(value.documents)
		const images = this.#parseStringArray(value.images)
		const tools = this.#parseStringArray(value.tools)
		const messages = this.#parseStringArray(value.messages)
		return {
			instructions: instructions.length > 0 ? instructions : undefined,
			documents: documents.length > 0 ? documents : undefined,
			images: images.length > 0 ? images : undefined,
			tools: tools.length > 0 ? tools : undefined,
			messages: messages.length > 0 ? messages : undefined,
		}
	}

	#parseBudget(value: unknown): TokenBudgetOptions | undefined {
		if (!isRecord(value)) return undefined
		const max = typeof value.max === 'number' ? value.max : 0
		if (max <= 0) return undefined
		const scope = parseEnum(value.scope, ['completion', 'total'] as const)
		return { max, scope }
	}

	#parseInstructions(value: unknown): { name: string; content: string; priority?: number }[] {
		if (!Array.isArray(value)) return []
		const result: { name: string; content: string; priority?: number }[] = []
		for (const item of value) {
			if (!isRecord(item)) continue
			const name = parseStringField(item, 'name')
			const content = parseStringField(item, 'content')
			if (name === undefined || content === undefined) continue
			const priority = typeof item.priority === 'number' ? item.priority : undefined
			result.push({ name, content, priority })
		}
		return result
	}

	#parseDocuments(value: unknown): { path: string; content: string; language: string }[] {
		if (!Array.isArray(value)) return []
		const result: { path: string; content: string; language: string }[] = []
		for (const item of value) {
			if (!isRecord(item)) continue
			const path = parseStringField(item, 'path')
			const content = parseStringField(item, 'content')
			if (path === undefined || content === undefined) continue
			const language = parseStringField(item, 'language') ?? ''
			result.push({ path, content, language })
		}
		return result
	}

	#parseImages(value: unknown): {
		name: string
		data: string
		mime?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
	}[] {
		if (!Array.isArray(value)) return []
		const result: {
			name: string
			data: string
			mime?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
		}[] = []
		for (const item of value) {
			if (!isRecord(item)) continue
			const name = parseStringField(item, 'name')
			const data = parseStringField(item, 'data')
			if (name === undefined || data === undefined) continue
			const rawMime = parseStringField(item, 'mime')
			const mime = rawMime !== undefined && isImageMimeType(rawMime) ? rawMime : undefined
			result.push({ name, data, mime })
		}
		return result
	}
}
