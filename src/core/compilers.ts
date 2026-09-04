import type { TableMap } from '@orkestrel/database'
import type { ContractShape } from '@orkestrel/contract'
import type { ColumnPrimitive, ColumnSpec, TableSpec } from './types.js'
import {
	booleanShape,
	integerShape,
	isString,
	numberShape,
	optionalShape,
	stringShape,
} from '@orkestrel/contract'

// Toolbox compilers — the config-only `TableSpec` column DSL compiled into the live
// `@orkestrel/database` `TableMap` a `createDatabase` call accepts. Pure and total: one composite
// walk over the spec, and the `compileColumn` / `compileColumnPrimitive` leaves it maps with.

/**
 * Compiles a {@link TableSpec} into the `@orkestrel/database` {@link TableMap} it configures —
 * each {@link ColumnSpec} maps to the matching primitive shaper (`'string'` → `stringShape()`,
 * `'integer'` → `integerShape()`, `'number'` → `numberShape()`, `'boolean'` → `booleanShape()`),
 * wrapped in `optionalShape` when the column declares `optional: true`. Total, pure.
 *
 * @param spec - The small-model-facing table layout
 * @returns The compiled `TableMap` a `@orkestrel/database` `createDatabase` call accepts
 */
export function expandTables(spec: TableSpec): TableMap {
	const tables: Record<string, Readonly<Record<string, ContractShape>>> = {}
	for (const [table, definition] of Object.entries(spec)) {
		const columns: Record<string, ContractShape> = {}
		for (const [column, columnSpec] of Object.entries(definition.columns)) {
			columns[column] = compileColumn(columnSpec)
		}
		tables[table] = columns
	}
	return tables
}

/**
 * Compiles one {@link ColumnSpec} into its `@orkestrel/database` column shape — the per-column leaf
 * {@link expandTables} maps over.
 *
 * @param spec - The column spec to compile
 * @returns The `@orkestrel/database` column shape, wrapped in `optionalShape` when the spec declares `optional: true`
 */
export function compileColumn(spec: ColumnSpec): ContractShape {
	const primitive = isString(spec) ? spec : spec.primitive
	const optional = !isString(spec) && spec.optional === true
	const shape = compileColumnPrimitive(primitive)
	return optional ? optionalShape(shape) : shape
}

/**
 * Compiles one {@link import('./types.js').ColumnPrimitive} into its primitive
 * `@orkestrel/database` shape — the leaf {@link compileColumn} wraps.
 *
 * @param primitive - The declared column primitive
 * @returns The matching primitive `@orkestrel/database` shape
 */
export function compileColumnPrimitive(primitive: ColumnPrimitive): ContractShape {
	if (primitive === 'string') return stringShape()
	if (primitive === 'integer') return integerShape()
	if (primitive === 'number') return numberShape()
	return booleanShape()
}
