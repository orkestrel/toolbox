import type { TableMap } from '@orkestrel/database'
import type { ContractShape } from '@orkestrel/contract'
import type { ColumnKind, ColumnSpec, TableSpec } from './types.js'
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
// walk over the spec, and the two leaves it maps with.

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

/** Compiles one {@link ColumnSpec} into its `@orkestrel/database` column shape — the per-column leaf {@link expandTables} maps over. */
export function compileColumn(spec: ColumnSpec): ContractShape {
	const kind = isString(spec) ? spec : spec.type
	const optional = !isString(spec) && spec.optional === true
	const shape = compileColumnKind(kind)
	return optional ? optionalShape(shape) : shape
}

/** Compiles one {@link import('./types.js').ColumnKind} into its primitive `@orkestrel/database` shape — the leaf {@link compileColumn} wraps. */
export function compileColumnKind(kind: ColumnKind): ContractShape {
	if (kind === 'string') return stringShape()
	if (kind === 'integer') return integerShape()
	if (kind === 'number') return numberShape()
	return booleanShape()
}
