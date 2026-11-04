import type { Guard } from '@orkestrel/contract'
import type { IndexMap, PrimaryMap } from '@orkestrel/database'
import type {
	AgentFunction,
	ColumnPrimitive,
	ColumnSpec,
	DatabaseDefinition,
	TableSpec,
	WorkflowLineage,
} from './types.js'
import {
	attempt,
	holds,
	isArray,
	isBoolean,
	isFiniteNumber,
	isFunction,
	isNonEmptyString,
	isRecord,
	isString,
	literalOf,
	recordOf,
	unionOf,
} from '@orkestrel/contract'

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
		if (!isArray(value)) return false
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
		if (!isFunction(value) || !Object.isFrozen(value)) return false
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
 * Narrows an unknown value to a {@link ColumnPrimitive}.
 *
 * @param value - The value to inspect
 * @returns True if `value` is `'string'`, `'integer'`, `'number'`, or `'boolean'`; false otherwise
 */
export const isColumnPrimitive: Guard<ColumnPrimitive> = literalOf(
	'string',
	'integer',
	'number',
	'boolean',
)

/**
 * Narrows an unknown value to a {@link ColumnSpec} — a bare {@link ColumnPrimitive}, or exactly
 * `{ primitive, optional? }`.
 *
 * @param value - The value to inspect
 * @returns True if `value` is a valid shorthand or an exact record with a valid `primitive`; false otherwise
 */
export const isColumnSpec: Guard<ColumnSpec> = unionOf(
	isColumnPrimitive,
	recordOf({ primitive: isColumnPrimitive, optional: isBoolean }, ['optional']),
)

/**
 * Narrows an unknown value to a {@link TableSpec} — table name to exactly `{ columns }`, each column
 * a valid {@link ColumnSpec}.
 *
 * @param value - The value to inspect
 * @returns True if `value` is a table layout; false otherwise
 */
export function isTableSpec(value: unknown): value is TableSpec {
	return holds(
		() =>
			isRecord(value) &&
			Object.values(value).every(
				(table) =>
					isRecord(table) &&
					Object.keys(table).length === 1 &&
					isRecord(table.columns) &&
					Object.values(table.columns).every((column) => isColumnSpec(column)),
			),
	)
}

/**
 * Narrows an unknown value to a `PrimaryMap` (`@orkestrel/database`) — table name to a nonempty
 * primary-key column name.
 *
 * @param value - The value to inspect
 * @returns True if every value is a nonempty string; false otherwise
 */
export function isPrimaryMap(value: unknown): value is PrimaryMap {
	return holds(() => isRecord(value) && Object.values(value).every((key) => isNonEmptyString(key)))
}

/**
 * Narrows an unknown value to an `IndexMap` (`@orkestrel/database`) — table name to its index
 * groups, each group a nonempty list of nonempty column names.
 *
 * @param value - The value to inspect
 * @returns True if every value is a list of such groups; false otherwise
 */
export function isIndexMap(value: unknown): value is IndexMap {
	return holds(
		() =>
			isRecord(value) &&
			Object.values(value).every(
				(groups) =>
					isArray(groups) &&
					groups.every(
						(group) =>
							isArray(group) &&
							group.length > 0 &&
							group.every((column) => isNonEmptyString(column)),
					),
			),
	)
}

/**
 * Narrows an unknown value to exactly a {@link DatabaseDefinition} — a non-empty `id` and `driver`,
 * a {@link TableSpec}, plus optional `primary`, `indexes`, and finite `version` schema configuration,
 * refusing every other key. The boundary guard a {@link import('./types.js').DefinitionStoreInterface}
 * applies to an untrusted persisted blob before trusting it as a definition (never an `as`).
 *
 * @remarks
 * A lockstep test holds this guard to {@link import('./shapers.js').definitionShape}.
 *
 * @param value - The value to inspect
 * @returns True if `value` is a complete {@link DatabaseDefinition}; false otherwise
 */
export const isDatabaseDefinition: Guard<DatabaseDefinition> = recordOf(
	{
		id: isNonEmptyString,
		driver: isNonEmptyString,
		tables: isTableSpec,
		primary: isPrimaryMap,
		indexes: isIndexMap,
		version: isFiniteNumber,
	},
	['primary', 'indexes', 'version'],
)
