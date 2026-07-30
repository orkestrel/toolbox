import { AgentToolError, isAgentToolError } from '@src/core'
import { describe, expect, it } from 'vitest'

// tests/src/core/errors.test.ts — mirrors src/core/errors.ts. `AgentToolError` mirrors
// `WorkflowError`'s exact shape (code + optional context); `isAgentToolError` is its
// total type guard.

describe('AgentToolError', () => {
	it('carries name/message/code, with no context when omitted', () => {
		const error = new AgentToolError('TOOL', 'task is required')
		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('AgentToolError')
		expect(error.message).toBe('task is required')
		expect(error.code).toBe('TOOL')
		expect(error.context).toBeUndefined()
		expect(error).not.toHaveProperty('context')
	})

	it('carries an optional structured context bag', () => {
		const error = new AgentToolError('DEPTH', 'cycle detected', { agent: 'reviewer', depth: 3 })
		expect(error.code).toBe('DEPTH')
		expect(error.context).toEqual({ agent: 'reviewer', depth: 3 })
	})

	it('supports both error codes (TOOL / DEPTH)', () => {
		expect(new AgentToolError('TOOL', 'x').code).toBe('TOOL')
		expect(new AgentToolError('DEPTH', 'x').code).toBe('DEPTH')
	})

	it('is throwable and catchable as a standard Error', () => {
		const thrown = (): void => {
			throw new AgentToolError('TOOL', 'boom')
		}
		expect(thrown).toThrow('boom')
		expect(thrown).toThrow(AgentToolError)
	})
})

describe('isAgentToolError — the total type guard', () => {
	it('accepts a real AgentToolError instance', () => {
		expect(isAgentToolError(new AgentToolError('TOOL', 'x'))).toBe(true)
	})

	it('rejects a plain Error, and non-error values, without throwing', () => {
		expect(isAgentToolError(new Error('x'))).toBe(false)
		for (const value of [undefined, null, 42, 'error', {}, [], { code: 'TOOL', message: 'x' }]) {
			expect(isAgentToolError(value)).toBe(false)
		}
	})
})
