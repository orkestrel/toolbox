import type {
	DatabaseDefinition,
	DatabaseDefinitionRow,
	DefinitionStoreInterface,
} from '../types.js'
import type { AuditFault } from '@orkestrel/contract'
import type { TableInterface } from '@orkestrel/database'
import { describeFaults, preview } from '@orkestrel/contract'
import { definitionContract } from '../contracts.js'
import { ToolboxError } from '../errors.js'
import { describeDefinitionMismatch, describeDefinitionRefusal, limitRefusal } from '../helpers.js'
import { isDatabaseDefinition } from '../validators.js'

/**
 * Represents a {@link DefinitionStoreInterface} backed by one table of the `@orkestrel/database` layer — a
 * database's durable config state is a row, so persistence reduces to keyed point-access
 * (`get` / `set` / `delete`) over a {@link TableInterface}, the driver-pluggable twin of the
 * plain-`Map` {@link import('./MemoryDefinitionStore.js').MemoryDefinitionStore}.
 *
 * @remarks
 * The store is driver-agnostic: it holds a single {@link TableInterface} whose backend (memory,
 * JSON, SQLite, IndexedDB) is chosen by whoever builds it (the factories), so a JSON / SQLite /
 * IndexedDB backend swaps in without touching a consumer — the same seam as
 * {@link import('./MemoryDefinitionStore.js').MemoryDefinitionStore}. The driver defaults to
 * memory ({@link import('../factories.js').createDatabaseDefinitionStore} passes
 * `createMemoryDriver()`), so it also works in memory out of the box; you opt into the durable
 * plumbing by passing a JSON / SQLite / IndexedDB driver.
 *
 * The {@link DatabaseDefinition} is stored as one opaque JSON column — the table is a row of
 * `{ id; definition }` ({@link DatabaseDefinitionRow}). The definition is already a complete,
 * self-contained, pure-JSON config payload (never a live handle), so storing it whole is lossless
 * and keeps the row type flat (`definition` reads back as `unknown`).
 *
 * - **`set(definition)` upserts under the definition's own `id`** (no separate id param) — it
 *   writes the row `{ id: definition.id, definition }`, and first refuses what `get` would refuse,
 *   so no row is written that `get` cannot read.
 * - **`get(id)` resolves the stored definition for an id**, narrowing the opaque JSON column back
 *   to a {@link DatabaseDefinition} ({@link import('../validators.js').isDatabaseDefinition} — the
 *   boundary narrow for an untrusted storage read), or `undefined` if no row is stored. A present
 *   row whose blob is malformed or names another id throws, because reading it as absent would let
 *   a later `set` overwrite it.
 * - **`delete(id)` drops a definition by id** without reading it, the remedy for a refused row; an
 *   absent id is a no-op (no throw).
 *
 * The public surface is exactly `get` / `set` / `delete` — no extra members (the method
 * bijection with {@link DefinitionStoreInterface}).
 *
 * @example
 * ```ts
 * import { createDatabaseDefinitionStore, createMemoryDriver } from '@src/core'
 *
 * const store = createDatabaseDefinitionStore(createMemoryDriver()) // a durable driver swaps in here
 * await store.set({ id: 'shop', driver: 'memory', tables: {} }) // persist the config (one JSON column)
 * const definition = await store.get('shop')
 * await store.delete('shop')
 * ```
 */
export class DatabaseDefinitionStore implements DefinitionStoreInterface {
	readonly #table: TableInterface<DatabaseDefinitionRow>

	/**
	 * Wraps a table as a definition store.
	 *
	 * @param table - The {@link TableInterface} holding the definitions — its row is the
	 *   {@link DatabaseDefinitionRow} `{ id; definition }` shape (the definition one opaque JSON column)
	 */
	constructor(table: TableInterface<DatabaseDefinitionRow>) {
		this.#table = table
	}

	/**
	 * Resolves the persisted definition for `id`, narrowing the opaque JSON column back to a
	 * {@link DatabaseDefinition}.
	 *
	 * @param id - The database id to read
	 * @returns The stored {@link DatabaseDefinition}, or `undefined` when no row is stored
	 * @throws {ToolboxError} Thrown with code `DATABASE` when the row's blob is malformed or names another id, with the faults under `context.faults`
	 */
	async get(id: string): Promise<DatabaseDefinition | undefined> {
		const row = await this.#table.get(id)
		if (row === undefined) return undefined
		// The definition crosses back as an untrusted storage read (a structured clone / a JSON
		// row), so narrow the opaque JSON column with the boundary guard rather than a cast;
		// `audit` runs only after the guard refused, to fill the faults.
		const definition = row.definition
		if (!isDatabaseDefinition(definition)) {
			const faults = definitionContract.audit(definition)
			throw new ToolboxError('DATABASE', describeDefinitionRefusal(id, faults), { id, faults })
		}
		if (definition.id !== id) {
			const faults: readonly AuditFault[] = [
				{ reason: 'type', path: ['id'], expected: 'literal', received: preview(definition.id) },
			]
			throw new ToolboxError('DATABASE', describeDefinitionMismatch(id, definition.id), {
				id,
				faults,
			})
		}
		return definition
	}

	/**
	 * Inserts or replaces a definition under its own `id` — the written row is `{ id, definition }`.
	 *
	 * @param definition - The config to persist; its own `id` is the row key (no separate id param)
	 * @returns A promise settling after the row is written
	 * @throws {ToolboxError} Thrown with code `DATABASE` before any write when the definition fails the guard `get` reads, with the faults under `context.faults`
	 */
	async set(definition: DatabaseDefinition): Promise<void> {
		if (!isDatabaseDefinition(definition)) {
			const unchecked: unknown = definition
			const faults = definitionContract.audit(unchecked)
			throw new ToolboxError(
				'DATABASE',
				limitRefusal(
					`a definition store writes only a complete definition; correct each line and call set again:\n${describeFaults(faults, definitionContract.schema)}`,
				),
				{ faults },
			)
		}
		await this.#table.set({ id: definition.id, definition })
	}

	/**
	 * Drops the definition stored under `id`.
	 *
	 * @param id - The database id to drop; an absent id is a no-op, never a throw
	 * @returns A promise settling after no row is stored under `id`
	 */
	async delete(id: string): Promise<void> {
		await this.#table.remove(id)
	}
}
