import {
	createAgentFunction,
	definitionContract,
	isAgentFunction,
	isColumnPrimitive,
	isColumnSpec,
	isDatabaseDefinition,
	isIndexMap,
	isPrimaryMap,
	isTableSpec,
	isWorkflowLineage,
} from '@src/core'
import { createAgent } from '@orkestrel/agent'
import { describe, expect, it } from 'vitest'
import { DEFINITION_CASES, ScriptedProvider, throwingGetWorkflowArguments } from '../../setup.js'

// tests/src/core/validators.test.ts — mirrors src/core/validators.ts. Every guard is driven with
// real values (AGENTS' no-mocks rule): live lineages, a live agent adapter, and untrusted
// database definitions, including the hostile boundary values a revoked proxy and an obsolete
// field present.

describe('isWorkflowLineage — narrow to a strict alternating workflow/agent chain', () => {
	it('validates strict alternating unique nonempty tags beginning with workflow', () => {
		expect(isWorkflowLineage([])).toBe(true)
		expect(isWorkflowLineage(['workflow:root', 'agent:a', 'workflow:child'])).toBe(true)
		for (const invalid of [
			['agent:a'],
			['workflow:'],
			['workflow:a', 'workflow:b'],
			['workflow:a', 'agent:b', 'workflow:a'],
			['workflow:a', 'agent:b', 'agent:c'],
		]) {
			expect(isWorkflowLineage(invalid)).toBe(false)
		}
		const revoked = Proxy.revocable<readonly string[]>(['workflow:root'], {})
		revoked.revoke()
		expect(isWorkflowLineage(revoked.proxy)).toBe(false)
	})
})

describe('isAgentFunction — narrow to a minted agent adapter', () => {
	it('recognizes only frozen agent adapters carrying frozen valid metadata', () => {
		const fn = createAgentFunction(createAgent(new ScriptedProvider([{ content: 'ok' }])))
		expect(isAgentFunction(fn)).toBe(true)
		expect(isAgentFunction(() => 'opaque')).toBe(false)
		expect(
			isAgentFunction(
				Object.freeze(
					Object.assign(() => 'spoof', {
						category: 'agent',
						lineage: ['agent:wrong'],
					}),
				),
			),
		).toBe(false)
		const revoked = Proxy.revocable(() => 'revoked', {})
		revoked.revoke()
		expect(isAgentFunction(revoked.proxy)).toBe(false)
	})
})

describe('isColumnPrimitive — narrow to a valid ColumnPrimitive literal', () => {
	it('accepts every ColumnPrimitive', () => {
		expect(isColumnPrimitive('string')).toBe(true)
		expect(isColumnPrimitive('integer')).toBe(true)
		expect(isColumnPrimitive('number')).toBe(true)
		expect(isColumnPrimitive('boolean')).toBe(true)
	})

	it('rejects a non-ColumnPrimitive string and a non-string value', () => {
		expect(isColumnPrimitive('text')).toBe(false)
		expect(isColumnPrimitive('')).toBe(false)
		expect(isColumnPrimitive(42)).toBe(false)
		expect(isColumnPrimitive(undefined)).toBe(false)
		expect(isColumnPrimitive(null)).toBe(false)
		expect(isColumnPrimitive({})).toBe(false)
	})
})

describe('isColumnSpec — narrow to a bare ColumnPrimitive or a { primitive, optional } object', () => {
	it('accepts a bare ColumnPrimitive shorthand', () => {
		expect(isColumnSpec('string')).toBe(true)
		expect(isColumnSpec('integer')).toBe(true)
		expect(isColumnSpec('number')).toBe(true)
		expect(isColumnSpec('boolean')).toBe(true)
	})

	it('accepts the object form with a valid primitive, with and without optional', () => {
		expect(isColumnSpec({ primitive: 'string' })).toBe(true)
		expect(isColumnSpec({ primitive: 'integer', optional: true })).toBe(true)
		expect(isColumnSpec({ primitive: 'boolean', optional: false })).toBe(true)
	})

	it('rejects an invalid primitive, a wrong-typed optional, and junk values', () => {
		expect(isColumnSpec({ primitive: 'text' })).toBe(false)
		expect(isColumnSpec({ primitive: 'string', optional: 'yes' })).toBe(false)
		expect(isColumnSpec({})).toBe(false)
		expect(isColumnSpec({ primitive: 'string', optional: undefined })).toBe(false)
		expect(isColumnSpec({ primitive: 'string', note: 'x' })).toBe(false)
		expect(isColumnSpec(null)).toBe(false)
		expect(isColumnSpec(42)).toBe(false)
		expect(isColumnSpec('text')).toBe(false)
		expect(isColumnSpec([])).toBe(false)
	})
})

describe('isDatabaseDefinition — narrow an untrusted value to a DatabaseDefinition', () => {
	const valid = {
		id: 'db-1',
		driver: 'memory',
		tables: {
			widgets: { columns: { name: 'string', qty: { primitive: 'integer', optional: true } } },
		},
		primary: { widgets: 'name' },
		indexes: { widgets: [['name'], ['name', 'qty']] },
		version: 2.5,
	}

	it('accepts a full valid definition, with and without optional schema configuration', () => {
		expect(isDatabaseDefinition(valid)).toBe(true)
		const {
			primary: _primary,
			indexes: _indexes,
			version: _version,
			...withoutConfiguration
		} = valid
		expect(isDatabaseDefinition(withoutConfiguration)).toBe(true)
	})

	it('rejects a missing or empty id / driver', () => {
		const { id: _id, ...withoutId } = valid
		expect(isDatabaseDefinition(withoutId)).toBe(false)
		expect(isDatabaseDefinition({ ...valid, id: '' })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, driver: '' })).toBe(false)
	})

	it('rejects malformed tables / columns', () => {
		expect(isDatabaseDefinition({ ...valid, tables: 'nope' })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, tables: { widgets: 'nope' } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, tables: { widgets: { columns: 'nope' } } })).toBe(false)
		expect(
			isDatabaseDefinition({ ...valid, tables: { widgets: { columns: { name: 'text' } } } }),
		).toBe(false)
	})

	it('rejects wrong-typed primary values and the obsolete keys field', () => {
		expect(isDatabaseDefinition({ ...valid, primary: 'nope' })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, primary: { widgets: 42 } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, primary: { widgets: '' } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, primary: undefined, keys: { widgets: 'name' } })).toBe(
			false,
		)
	})

	it('accepts empty index lists and rejects malformed groups or nonfinite versions', () => {
		expect(isDatabaseDefinition({ ...valid, indexes: { widgets: [] } })).toBe(true)
		expect(isDatabaseDefinition({ ...valid, indexes: { widgets: [[]] } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, indexes: { widgets: [['']] } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, indexes: { widgets: 'name' } })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, version: Number.NaN })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, version: Number.NEGATIVE_INFINITY })).toBe(false)
	})

	it('rejects non-objects', () => {
		expect(isDatabaseDefinition(null)).toBe(false)
		expect(isDatabaseDefinition(undefined)).toBe(false)
		expect(isDatabaseDefinition('nope')).toBe(false)
		expect(isDatabaseDefinition(42)).toBe(false)
		expect(isDatabaseDefinition([])).toBe(false)
	})

	it('is exact on owned keys: an undeclared key and an own undefined optional refuse', () => {
		expect(isDatabaseDefinition({ ...valid, note: 'x' })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, version: undefined })).toBe(false)
		expect(isDatabaseDefinition({ ...valid, primary: undefined })).toBe(false)
		expect(
			isDatabaseDefinition({ ...valid, tables: { widgets: { columns: {}, note: 'x' } } }),
		).toBe(false)
	})

	it('never throws: a record whose reads throw is false', () => {
		expect(isDatabaseDefinition(throwingGetWorkflowArguments)).toBe(false)
		expect(isTableSpec(throwingGetWorkflowArguments)).toBe(false)
		expect(isPrimaryMap(throwingGetWorkflowArguments)).toBe(false)
		expect(isIndexMap(throwingGetWorkflowArguments)).toBe(false)
	})

	it('moves in lockstep with definitionShape over every fixture, both ways', () => {
		const divergent = DEFINITION_CASES.filter(
			(fixture) => isDatabaseDefinition(fixture.value) !== definitionContract.is(fixture.value),
		).map((fixture) => fixture.label)
		expect(divergent).toEqual([])
		expect(
			DEFINITION_CASES.filter((fixture) => fixture.valid).map((fixture) => fixture.label),
		).toEqual(
			DEFINITION_CASES.filter((fixture) => isDatabaseDefinition(fixture.value)).map(
				(fixture) => fixture.label,
			),
		)
	})
})

describe('isTableSpec / isPrimaryMap / isIndexMap — the definition guard parts', () => {
	it('isTableSpec holds table name to exactly { columns } of valid column specs', () => {
		expect(isTableSpec({})).toBe(true)
		expect(isTableSpec({ items: { columns: {} } })).toBe(true)
		expect(isTableSpec({ items: { columns: { id: 'string' } } })).toBe(true)
		expect(isTableSpec({ items: {} })).toBe(false)
		expect(isTableSpec({ items: { columns: { id: 'text' } } })).toBe(false)
		expect(isTableSpec({ items: { columns: {}, note: 'x' } })).toBe(false)
		expect(isTableSpec('items')).toBe(false)
	})

	it('isPrimaryMap holds table name to a nonempty column name', () => {
		expect(isPrimaryMap({})).toBe(true)
		expect(isPrimaryMap({ items: 'id' })).toBe(true)
		expect(isPrimaryMap({ items: '' })).toBe(false)
		expect(isPrimaryMap({ items: 1 })).toBe(false)
		expect(isPrimaryMap([])).toBe(false)
	})

	it('isIndexMap holds table name to groups of nonempty column names', () => {
		expect(isIndexMap({})).toBe(true)
		expect(isIndexMap({ items: [] })).toBe(true)
		expect(isIndexMap({ items: [['id'], ['id', 'name']] })).toBe(true)
		expect(isIndexMap({ items: [[]] })).toBe(false)
		expect(isIndexMap({ items: [['']] })).toBe(false)
		expect(isIndexMap({ items: 'id' })).toBe(false)
		expect(isIndexMap('items')).toBe(false)
	})
})
