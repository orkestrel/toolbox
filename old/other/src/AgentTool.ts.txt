/**
 * AgentTool
 *
 * Wraps an AgentManager as a tool, enabling sub-agent orchestration.
 * When invoked, creates a child agent, sends the task as a user message,
 * and returns the generated response.
 *
 * Supports full scope control (tools, instructions, documents, images,
 * messages), conversation seeding, timeouts, token budgets, and per-request
 * model selection.
 */

import type { AgentManagerInterface, MessageRole } from '@orkestrel/agent'
import { createOllamaProvider, createAgentManager, DEFAULT_OLLAMA_URL } from '@orkestrel/agent'
import type { ToolInterface } from '@orkestrel/core'
import { isRecord, isImageMimeType } from '@orkestrel/core'
import type { AgentToolInput, AgentToolInterface } from '../types.js'
import { AGENT_TOOL_PARAMETERS } from '../constants.js'
import { isAllowedMessageRole } from '../helpers'

// === AgentTool

export class AgentTool implements AgentToolInterface {
	readonly name: string
	readonly summary: string
	readonly description: string
	readonly parameters: Record<string, unknown>
	readonly #manager: AgentManagerInterface
	readonly #tools: readonly ToolInterface[]
	readonly #url: string
	readonly #timeout: number

	constructor(input: AgentToolInput) {
		this.name = input.name
		this.summary = input.summary
		this.description = input.description
		const cloned: unknown = structuredClone(AGENT_TOOL_PARAMETERS)
		this.parameters = isRecord(cloned) ? cloned : {}
		this.#manager = input.manager
		this.#tools = input.tools !== undefined ? [...input.tools] : []
		this.#url = input.url ?? DEFAULT_OLLAMA_URL
		this.#timeout = input.timeout ?? 120_000
	}

	get manager(): AgentManagerInterface {
		return this.#manager
	}

	async execute(args: Record<string, unknown>): Promise<unknown> {
		// Handle models listing query
		if (args.models === true) {
			return this.#listModels()
		}

		const task = typeof args.task === 'string' ? args.task : ''
		const system = typeof args.system === 'string' ? args.system : undefined
		const model = typeof args.model === 'string' && args.model.length > 0 ? args.model : undefined

		if (task.length === 0) {
			return { error: 'task is required and must be a non-empty string' }
		}

		// Use a model-specific manager when a different model is requested
		const manager = model !== undefined ? this.#createManagerForModel(model) : this.#manager

		const agent = manager.create({ system, model })

		// Register pre-configured tools with the child agent
		if (this.#tools.length > 0) {
			agent.context.tools.add([...this.#tools])
		}

		// Apply caller-provided instructions
		const instructions = this.#parseInstructions(args.instructions)
		if (instructions.length > 0) {
			agent.context.instructions.add(instructions)
		}

		// Apply caller-provided documents
		const documents = this.#parseDocuments(args.documents)
		if (documents.length > 0) {
			agent.context.documents.add(documents)
		}

		// Apply caller-provided images
		const images = this.#parseImages(args.images)
		if (images.length > 0) {
			agent.context.images.add(images)
		}

		// Apply caller-provided conversation messages (before the task message)
		const messages = this.#parseMessages(args.messages)
		if (messages.length > 0) {
			agent.context.messages.add(messages)
		}

		// Build comprehensive scope from top-level tools and nested scope object
		const toolNames = this.#parseStringArray(args.tools)
		const scopeConfig = this.#parseScope(args.scope)
		const hasToolScope = toolNames.length > 0 || scopeConfig.tools !== undefined
		const hasScopeConfig =
			scopeConfig.instructions !== undefined ||
			scopeConfig.documents !== undefined ||
			scopeConfig.images !== undefined ||
			scopeConfig.messages !== undefined

		if (hasToolScope || hasScopeConfig) {
			// Top-level tools param takes precedence; fall back to scope.tools
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

		// Apply timeout for sub-agent execution
		const timeout = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : undefined
		if (timeout !== undefined) {
			agent.context.timeouts.create(timeout)
		}

		// Apply token budget for sub-agent execution
		const budgetConfig = this.#parseBudget(args.budget)
		if (budgetConfig !== undefined) {
			agent.context.budgets.create(budgetConfig)
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

	// --- Private helpers: model management

	#createManagerForModel(model: string): AgentManagerInterface {
		const provider = createOllamaProvider({
			model,
			url: this.#url,
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
				const name = typeof entry.name === 'string' ? entry.name : ''
				if (name.length === 0) continue
				const size = typeof entry.size === 'number' ? entry.size : 0
				const modified = typeof entry.modified_at === 'string' ? entry.modified_at : ''
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
			const role = typeof item.role === 'string' ? item.role : ''
			const content = typeof item.content === 'string' ? item.content : ''
			if (!isAllowedMessageRole(role) || content.length === 0) continue
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

	#parseBudget(value: unknown): { max: number; scope?: 'completion' | 'total' } | undefined {
		if (!isRecord(value)) return undefined
		const max = typeof value.max === 'number' ? value.max : 0
		if (max <= 0) return undefined
		const scope = value.scope === 'completion' || value.scope === 'total' ? value.scope : undefined
		return { max, scope }
	}

	#parseInstructions(value: unknown): { name: string; content: string; priority?: number }[] {
		if (!Array.isArray(value)) return []
		const result: { name: string; content: string; priority?: number }[] = []
		for (const item of value) {
			if (!isRecord(item)) continue
			const name = typeof item.name === 'string' ? item.name : ''
			const content = typeof item.content === 'string' ? item.content : ''
			if (name.length === 0 || content.length === 0) continue
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
			const path = typeof item.path === 'string' ? item.path : ''
			const content = typeof item.content === 'string' ? item.content : ''
			if (path.length === 0 || content.length === 0) continue
			const language = typeof item.language === 'string' ? item.language : ''
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
			const name = typeof item.name === 'string' ? item.name : ''
			const data = typeof item.data === 'string' ? item.data : ''
			if (name.length === 0 || data.length === 0) continue
			const mime =
				typeof item.mime === 'string' && isImageMimeType(item.mime) ? item.mime : undefined
			result.push({ name, data, mime })
		}
		return result
	}
}
