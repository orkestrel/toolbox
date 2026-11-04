import { createContract } from '@orkestrel/contract'
import { definitionShape } from './shapers.js'

// Toolbox compiled contracts — shapes compiled once, for what reads them on a refusal path.

/**
 * Holds the compiled {@link import('./shapers.js').definitionShape}, whose `audit` fills the faults a
 * refused stored definition carries.
 *
 * @example
 * ```ts
 * import { definitionContract } from '@orkestrel/toolbox'
 *
 * definitionContract.audit({ id: 'shop', driver: 'memory', tables: {}, keys: {} })
 * // [{ reason: 'extra', path: ['keys'] }]
 * ```
 */
export const definitionContract = createContract(definitionShape)
