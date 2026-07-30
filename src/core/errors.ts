import type { AgentToolErrorCode } from './types.js'

// Tool-package errors — one error class per domain this package mints its own error for.
// `@orkestrel/workflow`'s `WorkflowError` and `@orkestrel/agent`'s `WorkspaceError` already
// cover the workflow tool + workspace tool's failure paths (imported and thrown as-is, never
// duplicated here per §6). `createAgentTool` / `createDescribeTool` are net-new and none of
// `@orkestrel/agent`'s error classes fit a pre-run validation / guard failure (`AgentJobError`
// REQUIRES a settled partial `AgentResult` it cannot construct before a run starts;
// `ConversationError` / `ProviderAbortError` / `WorkspaceError` are each scoped to an unrelated
// domain) — so this package mints ONE typed error, `AgentToolError`, mirroring `WorkflowError`'s
// exact shape (`code` + optional `context`) for the same reason: a thrown, machine-readable,
// code-bearing error the tool-handler contract (AGENTS §14) requires, never a `{ error }`
// return. `AgentToolError` is this package's general TOOL-CALL error — not scoped to agent
// delegation alone — so `createDescribeTool` (a malformed call / an unknown tool name) reuses it
// rather than minting a second class for the same `TOOL` misuse semantics.

/**
 * Thrown by {@link import('./factories.js').createAgentTool}'s and
 * {@link import('./factories.js').createDescribeTool}'s handlers on every failure path — a
 * malformed / unresolvable call or an unknown tool name (`TOOL`), a delegation that would
 * exceed the configured depth bound or re-enter an ancestor (`DEPTH`), a prompt cycle
 * (`DEADLOCK`), a prompt that expired before it was answered (`EXPIRE`), or an answer that
 * failed to apply (`ANSWER`) — the last three thrown by
 * {@link import('./factories.js').createPromptTool} / {@link import('./factories.js').createAnswerTool}.
 * The upcoming database / relation tools (SRC-1's later units) will throw it too: a typed
 * `@orkestrel/database` failure re-surfaces as `DATABASE`, a typed `@orkestrel/relation` failure
 * as `RELATION` — each carrying the package's own granular error code in `context`.
 *
 * @remarks
 * Carries a machine-readable `code` (see {@link import('./types.js').AgentToolErrorCode}) and
 * an optional `context` bag for structured diagnostics. The `ToolManagerInterface`
 * (`@orkestrel/agent`) isolates every throw into the canonical tool result's top-level `error`
 * (AGENTS §14) — nothing escapes the run.
 *
 * @example
 * ```ts
 * import { AgentToolError, isAgentToolError } from '@src/core'
 *
 * try {
 * 	throw new AgentToolError('TOOL', 'task is required')
 * } catch (error) {
 * 	if (isAgentToolError(error)) console.log(error.code) // 'TOOL'
 * }
 * ```
 */
export class AgentToolError extends Error {
	readonly code: AgentToolErrorCode
	declare readonly context?: Readonly<Record<string, unknown>>

	constructor(
		code: AgentToolErrorCode,
		message: string,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(message)
		this.name = 'AgentToolError'
		this.code = code
		if (context !== undefined) this.context = context
	}
}

/**
 * Type guard narrowing an unknown caught value to an {@link AgentToolError}.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns `true` when `value` is an {@link AgentToolError}
 *
 * @example
 * ```ts
 * import { isAgentToolError } from '@src/core'
 *
 * try {
 * 	// ...
 * } catch (error) {
 * 	if (isAgentToolError(error)) console.log(error.code)
 * }
 * ```
 */
export function isAgentToolError(value: unknown): value is AgentToolError {
	return value instanceof AgentToolError
}
