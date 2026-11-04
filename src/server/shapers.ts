import { jsonShape, objectShape, recordShape, stringShape } from '@orkestrel/contract'

// Server-package shapes — the wire body `createTerminalRoutes` admits, compiled once per bridge.

/**
 * Describes the body a terminal POST route admits — the pending form's `id` and its answers.
 *
 * @remarks
 * The shape closes the envelope. `@orkestrel/form`'s `isFormValues` guard still owns what one answer
 * holds, so this shape does not restate the field value union.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { terminalAnswerShape } from '@src/server'
 *
 * const contract = createContract(terminalAnswerShape)
 * contract.is({ id: 'form-1', values: { name: 'Ada' } }) // true
 * contract.audit({ id: 'form-1', values: {}, reply: true }) // [{ reason: 'extra', path: ['reply'] }]
 * ```
 */
export const terminalAnswerShape = objectShape({
	id: stringShape({ min: 1, description: 'The id of the pending form to answer.' }),
	values: recordShape(jsonShape(), { description: 'The form answers keyed by field name.' }),
})
