import type { DatabaseInterface, DriverInterface, KeyFunction } from '@orkestrel/database'
import type { DefinitionStoreInterface } from '../types.js'
import { createDatabase } from '@orkestrel/database'
import { ToolboxError } from '../errors.js'
import { expandTables } from '../compilers.js'

/**
 * Resolves database definitions into cached live handles for database tools.
 *
 * @example
 * ```ts
 * import { DatabaseResolver } from '@orkestrel/toolbox'
 *
 * const resolver = new DatabaseResolver(handles, drivers, generator, store)
 * const database = await resolver.resolve('shop')
 * ```
 */
export class DatabaseResolver {
	readonly #handles: Map<string, DatabaseInterface>
	readonly #drivers: Readonly<Record<string, () => DriverInterface>>
	readonly #generator: KeyFunction | undefined
	readonly #store: DefinitionStoreInterface | undefined

	/**
	 * Creates a database resolver over the tool's live state and optional definition store.
	 *
	 * @param handles - Initial live database handles cached by id
	 * @param drivers - Driver factories keyed by definition driver name
	 * @param generator - Optional key generator supplied to newly created databases
	 * @param store - Optional persistent definition store
	 */
	constructor(
		handles: ReadonlyMap<string, DatabaseInterface>,
		drivers: Readonly<Record<string, () => DriverInterface>>,
		generator?: KeyFunction,
		store?: DefinitionStoreInterface,
	) {
		this.#handles = new Map(handles)
		this.#drivers = drivers
		this.#generator = generator
		this.#store = store
	}

	/**
	 * Determines whether a live database is cached by id.
	 *
	 * @param id - Database id
	 * @returns True if a live handle is cached; false otherwise
	 */
	has(id: string): boolean {
		return this.#handles.has(id)
	}

	/**
	 * Reads a cached database without consulting the definition store.
	 *
	 * @param id - Database id
	 * @returns The cached live database, or `undefined`
	 */
	get(id: string): DatabaseInterface | undefined {
		return this.#handles.get(id)
	}

	/**
	 * Caches a live database by id.
	 *
	 * @param id - Database id
	 * @param database - Live database handle
	 * @returns Nothing
	 */
	set(id: string, database: DatabaseInterface): void {
		this.#handles.set(id, database)
	}

	/**
	 * Removes a cached live database by id.
	 *
	 * @param id - Database id
	 * @returns Nothing
	 */
	delete(id: string): void {
		this.#handles.delete(id)
	}

	/**
	 * Resolves a cached or stored database by id.
	 *
	 * @param id - Database definition id
	 * @returns The cached or newly constructed live database
	 */
	async resolve(id: string): Promise<DatabaseInterface> {
		const cached = this.#handles.get(id)
		if (cached !== undefined) return cached
		if (this.#store !== undefined) {
			const definition = await this.#store.get(id)
			if (definition !== undefined) {
				const factory = this.#drivers[definition.driver]
				if (factory === undefined) {
					throw new ToolboxError('TOOL', `unknown driver '${definition.driver}'`, {
						id,
						driver: definition.driver,
					})
				}
				const handle = createDatabase({
					driver: factory(),
					tables: expandTables(definition.tables),
					name: id,
					...(definition.primary === undefined ? {} : { primary: definition.primary }),
					...(definition.indexes === undefined ? {} : { indexes: definition.indexes }),
					...(definition.version === undefined ? {} : { version: definition.version }),
					...(this.#generator === undefined ? {} : { generator: this.#generator }),
				})
				this.set(id, handle)
				return handle
			}
		}
		throw new ToolboxError('TOOL', `unknown database '${id}'`, { id })
	}
}
