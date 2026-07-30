import { ToolboxError, isToolboxError } from '@src/core'
import { describe, expect, it } from 'vitest'

// tests/src/core/errors.test.ts — mirrors src/core/errors.ts. `ToolboxError` mirrors
// `WorkflowError`'s exact shape (code + optional context); `isToolboxError` is its
// total type guard.

describe('ToolboxError', () => {
	it('carries name/message/code, with no context when omitted', () => {
		const error = new ToolboxError('TOOL', 'task is required')
		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('ToolboxError')
		expect(error.message).toBe('task is required')
		expect(error.code).toBe('TOOL')
		expect(error.context).toBeUndefined()
		expect(error).not.toHaveProperty('context')
	})

	it('carries an optional structured context bag', () => {
		const error = new ToolboxError('DEPTH', 'cycle detected', { agent: 'reviewer', depth: 3 })
		expect(error.code).toBe('DEPTH')
		expect(error.context).toEqual({ agent: 'reviewer', depth: 3 })
	})

	it('supports both error codes (TOOL / DEPTH)', () => {
		expect(new ToolboxError('TOOL', 'x').code).toBe('TOOL')
		expect(new ToolboxError('DEPTH', 'x').code).toBe('DEPTH')
	})

	it('is throwable and catchable as a standard Error', () => {
		const thrown = (): void => {
			throw new ToolboxError('TOOL', 'boom')
		}
		expect(thrown).toThrow('boom')
		expect(thrown).toThrow(ToolboxError)
	})
})

describe('isToolboxError — the total type guard', () => {
	it('accepts a real ToolboxError instance', () => {
		expect(isToolboxError(new ToolboxError('TOOL', 'x'))).toBe(true)
	})

	it('rejects a plain Error, and non-error values, without throwing', () => {
		expect(isToolboxError(new Error('x'))).toBe(false)
		for (const value of [undefined, null, 42, 'error', {}, [], { code: 'TOOL', message: 'x' }]) {
			expect(isToolboxError(value)).toBe(false)
		}
	})
})
