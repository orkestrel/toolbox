import type {
	AgentFunction,
	ColumnPrimitive,
	ColumnSpec,
	DatabaseDefinition,
	WorkflowLineage,
} from './types.js'
import { attempt, isFiniteNumber, isNonEmptyString, isRecord, isString } from '@orkestrel/contract'

// Toolbox guards — the total `(value: unknown) => value is T` narrows this package applies at its
// untrusted boundaries: an authored lineage, a frozen agent adapter, the small-model column DSL,
// and a persisted database definition read back from a store.

/**
 * Narrows an unknown value to a valid alternating workflow lineage.
 *
 * @param value - The value to inspect
 * @returns True if `value` is a unique, nonempty-tagged workflow/agent chain; false otherwise
 */
export function isWorkflowLineage(value: unknown): value is WorkflowLineage {
	const inspected = attempt(() => {
		if (!Array.isArray(value)) return false
		const seen = new Set<string>()
		for (const [index, tag] of value.entries()) {
			if (!isString(tag)) return false
			const prefix = index % 2 === 0 ? 'workflow:' : 'agent:'
			if (!tag.startsWith(prefix) || tag.length === prefix.length || seen.has(tag)) return false
			seen.add(tag)
		}
		return true
	})
	return inspected.success && inspected.value
}

/**
 * Narrows an unknown callable to Toolbox's frozen contextual agent adapter metadata.
 *
 * @param value - The value to inspect
 * @returns True if it is a frozen {@link AgentFunction} with a frozen valid lineage; false otherwise
 */
export function isAgentFunction(value: unknown): value is AgentFunction {
	const inspected = attempt(() => {
		if (typeof value !== 'function' || !Object.isFrozen(value)) return false
		const category = Reflect.getOwnPropertyDescriptor(value, 'category')
		const lineage = Reflect.getOwnPropertyDescriptor(value, 'lineage')
		return (
			category?.value === 'agent' &&
			lineage !== undefined &&
			'value' in lineage &&
			Object.isFrozen(lineage.value) &&
			isWorkflowLineage(lineage.value)
		)
	})
	return inspected.success && inspected.value
}

/**
 * Narrows an unknown value to a {@link ColumnSpec}.
 *
 * @param value - The value to inspect
 * @returns True if `value` is a valid {@link ColumnPrimitive} shorthand or a `{ primitive, optional }` record with a valid `primitive`; false otherwise
 */
export function isColumnSpec(value: unknown): value is ColumnSpec {
	if (isColumnPrimitive(value)) return true
	if (!isRecord(value)) return false
	return (
		isColumnPrimitive(value.primitive) &&
		(value.optional === undefined || typeof value.optional === 'boolean')
	)
}

/**
 * Narrows an unknown value to a {@link ColumnPrimitive}.
 *
 * @param value - The value to inspect
 * @returns True if `value` is `'string'`, `'integer'`, `'number'`, or `'boolean'`; false otherwise
 */
export function isColumnPrimitive(value: unknown): value is ColumnPrimitive {
	return value === 'string' || value === 'integer' || value === 'number' || value === 'boolean'
}

/**
 * Narrows an unknown value to a {@link DatabaseDefinition} — a non-empty `id` + `driver`, a
 * `tables` record whose every value is `{ columns: record of valid ColumnSpec }`, plus optional
 * `primary`, `indexes`, and finite `version` schema configuration. The boundary guard a
 * {@link import('./types.js').DefinitionStoreInterface} applies to an untrusted persisted blob
 * before trusting it as a definition (never an `as`).
 *
 * @param value - The value to inspect
 * @returns True if `value` is a complete {@link DatabaseDefinition}; false otherwise
 */
export function isDatabaseDefinition(value: unknown): value is DatabaseDefinition {
	if (!isRecord(value)) return false
	if ('keys' in value) return false
	if (!isNonEmptyString(value.id) || !isNonEmptyString(value.driver)) return false
	if (!isRecord(value.tables)) return false
	for (const table of Object.values(value.tables)) {
		if (!isRecord(table) || !isRecord(table.columns)) return false
		for (const column of Object.values(table.columns)) {
			if (!isColumnSpec(column)) return false
		}
	}
	if (value.primary !== undefined) {
		if (!isRecord(value.primary)) return false
		for (const key of Object.values(value.primary)) {
			if (!isNonEmptyString(key)) return false
		}
	}
	if (value.indexes !== undefined) {
		if (!isRecord(value.indexes)) return false
		for (const groups of Object.values(value.indexes)) {
			if (!Array.isArray(groups)) return false
			for (const group of groups) {
				if (!Array.isArray(group) || group.length === 0) return false
				for (const column of group) {
					if (!isNonEmptyString(column)) return false
				}
			}
		}
	}
	if (value.version !== undefined && !isFiniteNumber(value.version)) return false
	return true
}
