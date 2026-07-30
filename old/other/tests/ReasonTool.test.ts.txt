import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import { createReason, createQuantitativeReasoner } from '@orkestrel/reason'
import { ReasonTool } from '@orkestrel/mcp'
import {
	emptySubject,
	quantitativeDef,
	sumGroup,
	fieldFactor,
	staticFactor,
	expectQuantitative,
	expectBatch,
} from '../../setup.js'
import type { TestDir } from '../../setupServer.js'
import {
	createTestDir,
	destroyTestDir,
	testDef,
	writeJson,
	writeJsDef,
	writeJsProviderDef,
	writeBrokenJs,
	storesFor,
	quantitativeValue,
	validateSchema,
} from '../../setupServer.js'
import { prop } from '@orkestrel/core'

describe('ReasonTool', () => {
	const scoreDef = quantitativeDef([sumGroup('g1', [fieldFactor('f1', 'score', { fallback: 0 })])])

	const reason = createReason({
		reasoners: [createQuantitativeReasoner()],
	})

	it('exposes name from input', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate scores',
			reason,
		})
		expect(tool.name).toBe('calc')
	})

	it('exposes description from input', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate scores',
			reason,
		})
		expect(tool.description).toBe('Calculate scores')
	})

	it('exposes summary from input', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate scores',
			reason,
		})
		expect(tool.summary).toBe('Calc')
	})

	it('has parameters schema with expected keys', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		expect(tool.parameters).toBeDefined()
		expect(tool.parameters['type']).toBe('object')
		const topProps = tool.parameters['properties'] as Record<string, unknown>
		expect(Object.keys(topProps)).toEqual(
			expect.arrayContaining(['definitionId', 'definition', 'subject']),
		)
	})

	it('executes with definitionId', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})
		const result = expectQuantitative(
			await tool.execute({
				definitionId: scoreDef.id,
				subject: { score: 85 },
			}),
		)
		expect(result.value).toBe(85)
	})

	it('executes with inline definition', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		const result = expectQuantitative(
			await tool.execute({
				definition: scoreDef,
				subject: { score: 42 },
			}),
		)
		expect(result.value).toBe(42)
	})

	it('inline definition takes precedence over definitionId', async () => {
		const otherDef = quantitativeDef([sumGroup('g1', [staticFactor('f1', 999)])], {
			id: 'other',
		})

		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})

		const result = expectQuantitative(
			await tool.execute({
				definitionId: scoreDef.id,
				definition: otherDef,
				subject: emptySubject,
			}),
		)
		expect(result.value).toBe(999)
	})

	it('throws for missing definition', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		await expect(tool.execute({})).rejects.toThrow('No definition provided')
	})

	it('throws for unknown definitionId', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})
		await expect(tool.execute({ definitionId: 'nonexistent' })).rejects.toThrow(
			'Definition not found',
		)
	})

	it('handles missing subject gracefully', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})
		const result = expectQuantitative(
			await tool.execute({
				definitionId: scoreDef.id,
			}),
		)
		expect(result.value).toBe(0)
	})

	it('handles non-object subject', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})
		// null and undefined default to empty subject
		for (const subject of [null, undefined]) {
			const result = expectQuantitative(await tool.execute({ definitionId: scoreDef.id, subject }))
			expect(result.value).toBe(0)
		}
		// non-object throws
		await expect(tool.execute({ definitionId: scoreDef.id, subject: 'hello' })).rejects.toThrow(
			'Invalid subject',
		)
	})

	it('handles invalid inline definition', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		await expect(tool.execute({ definition: { foo: 'bar' } })).rejects.toThrow(
			'missing required "type"',
		)
		await expect(tool.execute({ definition: 42 })).rejects.toThrow('expected an object')
	})

	it('handles definitionId that is not a string', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})
		await expect(tool.execute({ definitionId: 123 })).rejects.toThrow('No definition provided')
		await expect(tool.execute({ definitionId: null })).rejects.toThrow('No definition provided')
	})

	it('can execute multiple times with different subjects', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})
		const r1 = expectQuantitative(
			await tool.execute({ definitionId: scoreDef.id, subject: { score: 10 } }),
		)
		const r2 = expectQuantitative(
			await tool.execute({ definitionId: scoreDef.id, subject: { score: 99 } }),
		)
		expect(r1.value).toBe(10)
		expect(r2.value).toBe(99)
	})

	it('empty definitions array is handled', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [],
		})
		await expect(tool.execute({ definitionId: 'any-id' })).rejects.toThrow('Definition not found')
	})

	it('parameters returns consistent schema', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		const p1 = tool.parameters
		const p2 = tool.parameters
		expect(p1).toEqual(p2)
		const props = p1['properties'] as Record<string, unknown>
		expect(Object.keys(props)).toEqual(
			expect.arrayContaining(['definitionId', 'definition', 'subject']),
		)
	})

	it('parameters definition has type enum', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		const schemaProps = tool.parameters['properties'] as Record<string, unknown>
		const defSchema = schemaProps['definition']
		const props = prop(defSchema, 'properties')
		const typeField = prop(props, 'type')
		expect(prop(typeField, 'enum')).toEqual(['quantitative', 'logical', 'symbolic', 'inferential'])
	})

	it('throws descriptive error for invalid definition type', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		await expect(
			tool.execute({ definition: { type: 'nonsense', id: 'x', name: 'X' } }),
		).rejects.toThrow('Must be one of: quantitative, logical, symbolic, inferential')
	})

	it('throws descriptive error for definition missing id', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		await expect(
			tool.execute({
				definition: { type: 'quantitative', name: 'X', groups: [], aggregation: 'sum' },
			}),
		).rejects.toThrow('"id" (string) is required')
	})

	it('throws descriptive error for definition missing name', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		await expect(
			tool.execute({
				definition: { type: 'quantitative', id: 'x', groups: [], aggregation: 'sum' },
			}),
		).rejects.toThrow('"name" (string) is required')
	})

	it('includes available IDs in error when definitionId not found', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})
		await expect(tool.execute({ definitionId: 'wrong' })).rejects.toThrow(scoreDef.id)
	})

	it('throws for string subject', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})
		await expect(
			tool.execute({ definitionId: scoreDef.id, subject: 'not-an-object' }),
		).rejects.toThrow('Invalid subject')
	})

	it('throws for numeric subject', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			definitions: [scoreDef],
		})
		await expect(tool.execute({ definitionId: scoreDef.id, subject: 42 })).rejects.toThrow(
			'Invalid subject',
		)
	})

	it('throws for boolean definition', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		await expect(tool.execute({ definition: true })).rejects.toThrow('expected an object')
	})

	it('throws for string definition', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		await expect(tool.execute({ definition: 'quantitative' })).rejects.toThrow('expected an object')
	})

	describe('definitions', () => {
		it('returns pre-loaded definitions', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})
			const defs = tool.definitions()
			expect(defs.size).toBe(1)
			expect(defs.get(scoreDef.id)).toEqual(scoreDef)
		})

		it('returns a copy (mutations do not affect internal state)', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})
			const defs1 = tool.definitions()
			const defs2 = tool.definitions()
			expect(defs1).not.toBe(defs2)
			expect(defs1.size).toBe(defs2.size)
		})

		it('returns empty map when no definitions', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})
			expect(tool.definitions().size).toBe(0)
		})
	})

	describe('list', () => {
		it('returns stored definitions as summaries', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calculate',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})
			const items = tool.list()
			expect(items).toHaveLength(1)
			expect(items[0].id).toBe(scoreDef.id)
			expect(items[0].type).toBe('quantitative')
			expect(items[0].name).toBe(scoreDef.name)
		})

		it('returns empty array when no definitions', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calculate',
				description: 'Calculate',
				reason,
			})
			expect(tool.list()).toEqual([])
		})
	})

	describe('memory', () => {
		it('stores inline definition when memory: true in args', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})
			expect(tool.definitions().size).toBe(0)

			// Execute with inline definition + memory: true
			await tool.execute({
				definition: scoreDef,
				subject: { score: 50 },
				memory: true,
			})

			// Now the definition should be stored
			expect(tool.definitions().size).toBe(1)
			expect(tool.definitions().get(scoreDef.id)).toBeDefined()
		})

		it('allows reuse by definitionId after memory store', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			// First call: inline + memory
			await tool.execute({
				definition: scoreDef,
				subject: { score: 42 },
				memory: true,
			})

			// Second call: by id
			const result = expectQuantitative(
				await tool.execute({
					definitionId: scoreDef.id,
					subject: { score: 99 },
				}),
			)
			expect(result.value).toBe(99)
		})

		it('does not store when memory: false', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			await tool.execute({
				definition: scoreDef,
				subject: { score: 50 },
				memory: false,
			})

			expect(tool.definitions().size).toBe(0)
		})

		it('does not store when memory not set and tool default is false', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			await tool.execute({
				definition: scoreDef,
				subject: { score: 50 },
			})

			expect(tool.definitions().size).toBe(0)
		})

		it('stores when tool-level memory default is true', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				memory: true,
			})

			await tool.execute({
				definition: scoreDef,
				subject: { score: 50 },
			})

			expect(tool.definitions().size).toBe(1)
		})

		it('per-call memory: false overrides tool-level memory: true', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				memory: true,
			})

			await tool.execute({
				definition: scoreDef,
				subject: { score: 50 },
				memory: false,
			})

			expect(tool.definitions().size).toBe(0)
		})

		it('does not store definitions referenced by definitionId', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
				memory: true,
			})

			// Execute using definitionId — this is a reuse, not an inline definition
			await tool.execute({
				definitionId: scoreDef.id,
				subject: { score: 50 },
			})

			// Should still only have the original, no duplicate storage
			expect(tool.definitions().size).toBe(1)
		})

		it('overwrites existing definition with same id', async () => {
			const def1 = quantitativeDef([sumGroup('g1', [staticFactor('f1', 10)])], {
				id: 'shared-id',
			})
			const def2 = quantitativeDef([sumGroup('g1', [staticFactor('f1', 99)])], {
				id: 'shared-id',
			})

			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [def1],
			})

			// Overwrite with inline + memory
			await tool.execute({
				definition: def2,
				subject: {},
				memory: true,
			})

			const result = expectQuantitative(
				await tool.execute({ definitionId: 'shared-id', subject: {} }),
			)
			expect(result.value).toBe(99)
		})

		it('stores multiple definitions from separate calls', async () => {
			const def1 = quantitativeDef([sumGroup('g1', [staticFactor('f1', 10)])], { id: 'd1' })
			const def2 = quantitativeDef([sumGroup('g1', [staticFactor('f1', 20)])], { id: 'd2' })

			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			await tool.execute({ definition: def1, subject: {}, memory: true })
			await tool.execute({ definition: def2, subject: {}, memory: true })

			expect(tool.definitions().size).toBe(2)
			expect(tool.definitions().has('d1')).toBe(true)
			expect(tool.definitions().has('d2')).toBe(true)
		})
	})

	describe('forget', () => {
		it('removes a single definition by id', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})

			expect(tool.forget(scoreDef.id)).toBe(true)
			expect(tool.definitions().size).toBe(0)
		})

		it('returns false for non-existent id', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			expect(tool.forget('nonexistent')).toBe(false)
		})

		it('removes all definitions', async () => {
			const def1 = quantitativeDef([sumGroup('g1', [staticFactor('f1', 10)])], { id: 'd1' })
			const def2 = quantitativeDef([sumGroup('g1', [staticFactor('f1', 20)])], { id: 'd2' })

			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [def1, def2],
			})

			expect(tool.definitions().size).toBe(2)
			tool.forget()
			expect(tool.definitions().size).toBe(0)
		})

		it('makes forgotten definition unavailable by definitionId', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})

			tool.forget(scoreDef.id)
			await expect(tool.execute({ definitionId: scoreDef.id, subject: {} })).rejects.toThrow(
				'Definition not found',
			)
		})

		it('forgets a memory-stored definition', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			await tool.execute({ definition: scoreDef, subject: { score: 1 }, memory: true })
			expect(tool.definitions().size).toBe(1)

			expect(tool.forget(scoreDef.id)).toBe(true)
			expect(tool.definitions().size).toBe(0)
		})

		it('handles forget: true in execute args', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})

			expect(tool.definitions().size).toBe(1)
			const result = await tool.execute({ forget: true })
			expect(result).toEqual({
				success: true,
				message: 'Removed all 1 stored definition(s).',
			})
			expect(tool.definitions().size).toBe(0)
		})

		it('handles forget: string in execute args', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})

			expect(tool.definitions().size).toBe(1)
			const result = await tool.execute({ forget: scoreDef.id })
			expect(result).toEqual(
				expect.objectContaining({
					success: true,
					message: expect.stringContaining('Removed definition'),
				}),
			)
			expect(tool.definitions().size).toBe(0)
		})

		it('throws for invalid forget value in execute args', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			await expect(tool.execute({ forget: 42 })).rejects.toThrow('Invalid "forget" value')
			await expect(tool.execute({ forget: null })).rejects.toThrow('Invalid "forget" value')
		})
	})

	describe('persist', () => {
		it('persist: true implies memory: true', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			// persist without storagePath — memory still happens, just no file write
			await tool.execute({
				definition: scoreDef,
				subject: { score: 1 },
				persist: true,
			})

			expect(tool.definitions().size).toBe(1)
			expect(tool.definitions().has(scoreDef.id)).toBe(true)
		})

		it('persist without storagePath stores in memory only', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			// No storagePath, so persist just acts like memory
			await tool.execute({
				definition: scoreDef,
				subject: { score: 1 },
				persist: true,
			})

			expect(tool.definitions().size).toBe(1)
		})
	})

	describe('parameters schema', () => {
		it('includes memory field in parameters', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})
			const properties = tool.parameters['properties'] as Record<string, unknown>
			expect(properties['memory']).toBeDefined()
		})

		it('includes persist field in parameters', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})
			const properties = tool.parameters['properties'] as Record<string, unknown>
			expect(properties['persist']).toBeDefined()
		})

		it('includes forget field in parameters', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})
			const properties = tool.parameters['properties'] as Record<string, unknown>
			expect(properties['forget']).toBeDefined()
		})

		it('includes subjects field in parameters', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})
			const properties = tool.parameters['properties'] as Record<string, unknown>
			const subjects = properties['subjects']
			expect(subjects).toBeDefined()
			expect(prop(subjects, 'type')).toBe('array')
			expect(prop(subjects, 'items')).toEqual({ type: 'object', additionalProperties: true })
		})
	})

	describe('batch execute', () => {
		it('processes multiple subjects and returns array', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})
			const results = expectBatch(
				await tool.execute({
					definitionId: scoreDef.id,
					subjects: [{ score: 10 }, { score: 20 }, { score: 30 }],
				}),
			)
			expect(results).toHaveLength(3)
			expect(expectQuantitative(results[0]).value).toBe(10)
			expect(expectQuantitative(results[1]).value).toBe(20)
			expect(expectQuantitative(results[2]).value).toBe(30)
		})

		it('returns empty array for empty subjects', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})
			const results = expectBatch(
				await tool.execute({
					definitionId: scoreDef.id,
					subjects: [],
				}),
			)
			expect(results).toHaveLength(0)
		})

		it('batch with single subject returns array of length 1', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})
			const results = expectBatch(
				await tool.execute({
					definitionId: scoreDef.id,
					subjects: [{ score: 42 }],
				}),
			)
			expect(results).toHaveLength(1)
		})

		it('batch with inline definition', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})
			const results = expectBatch(
				await tool.execute({
					definition: scoreDef,
					subjects: [{ score: 5 }, { score: 15 }],
				}),
			)
			expect(results).toHaveLength(2)
			expect(expectQuantitative(results[0]).value).toBe(5)
			expect(expectQuantitative(results[1]).value).toBe(15)
		})

		it('subjects takes precedence over subject', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})
			const results = expectBatch(
				await tool.execute({
					definitionId: scoreDef.id,
					subject: { score: 999 },
					subjects: [{ score: 1 }, { score: 2 }],
				}),
			)
			expect(results).toHaveLength(2)
			expect(expectQuantitative(results[0]).value).toBe(1)
		})

		it('throws for non-array subjects', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})
			await expect(
				tool.execute({
					definitionId: scoreDef.id,
					subjects: 'not-an-array',
				}),
			).rejects.toThrow('Invalid subjects')
		})

		it('throws for invalid subject in batch', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
				definitions: [scoreDef],
			})
			await expect(
				tool.execute({
					definitionId: scoreDef.id,
					subjects: [{ score: 1 }, 'invalid'],
				}),
			).rejects.toThrow('Invalid subject at index 1')
		})

		it('batch handles memory storage for inline definitions', async () => {
			const tool = new ReasonTool({
				name: 'calc',
				summary: 'Calc',
				description: 'Calculate',
				reason,
			})

			await tool.execute({
				definition: scoreDef,
				subjects: [{ score: 1 }, { score: 2 }],
				memory: true,
			})

			expect(tool.definitions().size).toBe(1)
			expect(tool.definitions().has(scoreDef.id)).toBe(true)
		})
	})
})

// === ReasonTool with stores

describe('ReasonTool with stores', () => {
	let dir: TestDir

	const reason = createReason({
		reasoners: [createQuantitativeReasoner()],
	})

	beforeEach(async () => {
		dir = await createTestDir()
	})

	afterEach(async () => {
		await destroyTestDir(dir)
	})

	it('loads definitions from stores via init', async () => {
		writeJson(dir.root, 'score.json', testDef('score', 42))

		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()

		expect(tool.definitions().size).toBe(1)
		expect(tool.definitions().has('score')).toBe(true)
	})

	it('allows execute by definitionId from loaded store', async () => {
		writeJson(dir.root, 'score.json', testDef('score', 77))

		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()

		const result = await tool.execute({ definitionId: 'score', subject: {} })
		expect(quantitativeValue(result)).toBe(77)
	})

	it('loads from multiple stores', async () => {
		const dir2 = await createTestDir()
		writeJson(dir.root, 'a.json', testDef('a', 1))
		writeJson(dir2.root, 'b.json', testDef('b', 2))

		const stores = storesFor({ path: dir.root }, { path: dir2.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()

		expect(tool.definitions().size).toBe(2)
		await destroyTestDir(dir2)
	})

	it('later store overwrites earlier on collision', async () => {
		const dir2 = await createTestDir()
		writeJson(dir.root, 'shared.json', testDef('shared', 10))
		writeJson(dir2.root, 'shared.json', testDef('shared', 99))

		const stores = storesFor({ path: dir.root }, { path: dir2.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()

		const result = await tool.execute({ definitionId: 'shared', subject: {} })
		expect(quantitativeValue(result)).toBe(99)
		await destroyTestDir(dir2)
	})

	it('constructor definitions load before stores', async () => {
		writeJson(dir.root, 'shared.json', testDef('shared', 99))

		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
			definitions: [testDef('shared', 10)],
		})

		await tool.init()

		// Store overwrites constructor because it loads after
		const result = await tool.execute({ definitionId: 'shared', subject: {} })
		expect(quantitativeValue(result)).toBe(99)
	})

	it('skips nonexistent store directories gracefully', async () => {
		const stores = storesFor({ path: nodePath.join(dir.root, 'does-not-exist') })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()

		expect(tool.definitions().size).toBe(0)
	})

	it('exposes stores property', async () => {
		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})
		expect(tool.stores).toBe(stores)
	})

	it('stores is undefined when not configured', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})
		expect(tool.stores).toBeUndefined()
	})
})

// === ReasonTool persist (filesystem)

describe('ReasonTool persist (filesystem)', () => {
	let dir: TestDir

	const reason = createReason({
		reasoners: [createQuantitativeReasoner()],
	})

	beforeEach(async () => {
		dir = await createTestDir()
	})

	afterEach(async () => {
		await destroyTestDir(dir)
	})

	it('persist: true writes definition to writable store', async () => {
		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.execute({
			definition: testDef('persisted', 42),
			subject: {},
			persist: true,
		})

		const filePath = nodePath.join(dir.root, 'persisted.json')
		expect(fs.existsSync(filePath)).toBe(true)
		const content = JSON.parse(fs.readFileSync(filePath, 'utf8'))
		expect(content.id).toBe('persisted')
	})

	it('persisted definition survives new tool construction', async () => {
		const stores1 = storesFor({ path: dir.root })
		const tool1 = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores: stores1,
		})

		await tool1.execute({
			definition: testDef('survivor', 88),
			subject: {},
			persist: true,
		})

		// New tool instance with same store path picks it up
		const stores2 = storesFor({ path: dir.root })
		const tool2 = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores: stores2,
		})

		await tool2.init()

		expect(tool2.definitions().has('survivor')).toBe(true)
		const result = await tool2.execute({ definitionId: 'survivor', subject: {} })
		expect(quantitativeValue(result)).toBe(88)
	})

	it('persist creates store directory if missing', async () => {
		const nested = nodePath.join(dir.root, 'deep', 'storage')
		const stores = storesFor({ path: nested })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.execute({
			definition: testDef('deep-def', 1),
			subject: {},
			persist: true,
		})

		expect(fs.existsSync(nodePath.join(nested, 'deep-def.json'))).toBe(true)
	})

	it('forget removes persisted file from disk', async () => {
		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.execute({
			definition: testDef('to-forget', 1),
			subject: {},
			persist: true,
		})

		expect(fs.existsSync(nodePath.join(dir.root, 'to-forget.json'))).toBe(true)
		tool.forget('to-forget')
		// forget is synchronous but disk cleanup is fire-and-forget async
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(fs.existsSync(nodePath.join(dir.root, 'to-forget.json'))).toBe(false)
		expect(tool.definitions().has('to-forget')).toBe(false)
	})

	it('forget() removes all persisted files', async () => {
		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.execute({ definition: testDef('a', 1), subject: {}, persist: true })
		await tool.execute({ definition: testDef('b', 2), subject: {}, persist: true })

		expect(fs.readdirSync(dir.root).filter((f) => f.endsWith('.json'))).toHaveLength(2)
		tool.forget()
		expect(tool.definitions().size).toBe(0)
		// forget is synchronous but disk cleanup is fire-and-forget async
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(fs.readdirSync(dir.root).filter((f) => f.endsWith('.json'))).toHaveLength(0)
	})

	it('later store definitions load after earlier stores', async () => {
		const defsDir = await createTestDir()
		writeJson(defsDir.root, 'shared.json', testDef('shared', 10))
		writeJson(dir.root, 'shared.json', testDef('shared', 99))

		const stores = storesFor({ path: defsDir.root, writable: false }, { path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()

		// dir loads after defsDir, so 99 wins
		const result = await tool.execute({ definitionId: 'shared', subject: {} })
		expect(quantitativeValue(result)).toBe(99)
		await destroyTestDir(defsDir)
	})

	it('memory: true without persist does not write to disk', async () => {
		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.execute({
			definition: testDef('memory-only', 1),
			subject: {},
			memory: true,
		})

		expect(tool.definitions().has('memory-only')).toBe(true)
		expect(fs.existsSync(nodePath.join(dir.root, 'memory-only.json'))).toBe(false)
	})

	it('does not persist definitions reused by definitionId', async () => {
		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
			definitions: [testDef('preloaded', 50)],
		})

		await tool.execute({
			definitionId: 'preloaded',
			subject: {},
			persist: true,
		})

		expect(fs.existsSync(nodePath.join(dir.root, 'preloaded.json'))).toBe(false)
	})
})

// === ReasonTool init with JS/TS files

describe('ReasonTool init', () => {
	let dir: TestDir

	const reason = createReason({
		reasoners: [createQuantitativeReasoner()],
	})

	beforeEach(async () => {
		dir = await createTestDir()
	})

	afterEach(async () => {
		await destroyTestDir(dir)
	})

	it('loads JS definitions from stores via init()', async () => {
		writeJsDef(dir.root, 'score.js', 'js-score', 77)

		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		expect(tool.definitions().has('js-score')).toBe(false)

		await tool.init()

		expect(tool.definitions().has('js-score')).toBe(true)
		const result = await tool.execute({ definitionId: 'js-score', subject: {} })
		expect(quantitativeValue(result)).toBe(77)
	})

	it('merges JSON and JS definitions after init()', async () => {
		writeJson(dir.root, 'json-def.json', testDef('from-json', 10))
		writeJsDef(dir.root, 'js-def.js', 'from-js', 20)

		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		expect(tool.definitions().has('from-json')).toBe(false)
		expect(tool.definitions().has('from-js')).toBe(false)

		await tool.init()

		expect(tool.definitions().has('from-json')).toBe(true)
		expect(tool.definitions().has('from-js')).toBe(true)
	})

	it('init() is safe to call without stores', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		await tool.init()
		expect(tool.definitions().size).toBe(0)
	})

	it('init() is safe to call multiple times', async () => {
		writeJsDef(dir.root, 're.js', 'reloadable', 42)

		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()
		expect(tool.definitions().has('reloadable')).toBe(true)

		await tool.init()
		expect(tool.definitions().has('reloadable')).toBe(true)
	})

	it('JS definitions loaded via init() can override constructor definitions', async () => {
		writeJsDef(dir.root, 'override.js', 'override-me', 99)

		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
			definitions: [testDef('override-me', 10)],
		})

		expect(
			quantitativeValue(await tool.execute({ definitionId: 'override-me', subject: {} })),
		).toBe(10)

		await tool.init()

		expect(
			quantitativeValue(await tool.execute({ definitionId: 'override-me', subject: {} })),
		).toBe(99)
	})

	it('loads DefinitionProvider functions via init()', async () => {
		writeJsProviderDef(dir.root, 'dynamic.js', 'dynamic', 88)

		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()

		expect(tool.definitions().has('dynamic')).toBe(true)
		expect(quantitativeValue(await tool.execute({ definitionId: 'dynamic', subject: {} }))).toBe(88)
	})

	it('skips broken JS files during init() without crashing', async () => {
		writeJsDef(dir.root, 'good.js', 'good', 42)
		writeBrokenJs(dir.root, 'bad.js')

		const stores = storesFor({ path: dir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()

		expect(tool.definitions().has('good')).toBe(true)
		expect(tool.definitions().size).toBe(1)
	})

	it('loads from multiple stores with JS files', async () => {
		const dir2 = await createTestDir()
		writeJsDef(dir.root, 'a.js', 'a-def', 1)
		writeJsDef(dir2.root, 'b.js', 'b-def', 2)

		const stores = storesFor({ path: dir.root }, { path: dir2.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool.init()

		expect(tool.definitions().has('a-def')).toBe(true)
		expect(tool.definitions().has('b-def')).toBe(true)
		await destroyTestDir(dir2)
	})
})

// === ReasonTool import

describe('ReasonTool import', () => {
	let dir: TestDir
	let storeDir: TestDir

	const reason = createReason({
		reasoners: [createQuantitativeReasoner()],
	})

	beforeEach(async () => {
		dir = await createTestDir()
		storeDir = await createTestDir()
	})

	afterEach(async () => {
		await destroyTestDir(dir)
		await destroyTestDir(storeDir)
	})

	it('imports a JSON definition file', async () => {
		writeJson(dir.root, 'score.json', testDef('imported-json', 42))

		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.import(nodePath.join(dir.root, 'score.json'))
		expect(result.success).toBe(true)
		expect(result.id).toBe('imported-json')
		expect(tool.definitions().has('imported-json')).toBe(true)
		expect(
			quantitativeValue(await tool.execute({ definitionId: 'imported-json', subject: {} })),
		).toBe(42)
	})

	it('imports a JS definition file', async () => {
		writeJsDef(dir.root, 'score.js', 'imported-js', 77)

		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.import(nodePath.join(dir.root, 'score.js'))
		expect(result.success).toBe(true)
		expect(result.id).toBe('imported-js')
		expect(tool.definitions().has('imported-js')).toBe(true)
		expect(
			quantitativeValue(await tool.execute({ definitionId: 'imported-js', subject: {} })),
		).toBe(77)
	})

	it('imports a DefinitionProvider JS file', async () => {
		writeJsProviderDef(dir.root, 'provider.js', 'imported-provider', 88)

		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.import(nodePath.join(dir.root, 'provider.js'))
		expect(result.success).toBe(true)
		expect(result.id).toBe('imported-provider')
		expect(
			quantitativeValue(await tool.execute({ definitionId: 'imported-provider', subject: {} })),
		).toBe(88)
	})

	it('persists imported definition to stores', async () => {
		writeJson(dir.root, 'to-persist.json', testDef('persist-me', 55))

		const stores = storesFor({ path: storeDir.root })
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		const result = await tool.import(nodePath.join(dir.root, 'to-persist.json'))
		expect(result.success).toBe(true)
		expect(fs.existsSync(nodePath.join(storeDir.root, 'persist-me.json'))).toBe(true)
	})

	it('returns failure for missing file', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.import(nodePath.join(dir.root, 'nope.json'))
		expect(result.success).toBe(false)
		expect(result.id).toBeUndefined()
		expect(result.message).toContain('not found')
	})

	it('returns failure for unsupported extension', async () => {
		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.import(nodePath.join(dir.root, 'data.csv'))
		expect(result.success).toBe(false)
		expect(result.id).toBeUndefined()
		expect(result.message).toContain('Unsupported file extension')
	})

	it('returns failure for invalid JSON content', async () => {
		fs.writeFileSync(nodePath.join(dir.root, 'bad.json'), 'not json{{{', 'utf8')

		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.import(nodePath.join(dir.root, 'bad.json'))
		expect(result.success).toBe(false)
		expect(result.message).toContain('Invalid JSON')
	})

	it('returns failure for JSON missing id', async () => {
		fs.writeFileSync(nodePath.join(dir.root, 'noid.json'), JSON.stringify({ foo: 'bar' }), 'utf8')

		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.import(nodePath.join(dir.root, 'noid.json'))
		expect(result.success).toBe(false)
		expect(result.message).toContain('Not a valid reason definition')
	})

	it('returns failure for broken JS file', async () => {
		writeBrokenJs(dir.root, 'broken.js')

		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.import(nodePath.join(dir.root, 'broken.js'))
		expect(result.success).toBe(false)
		expect(result.message).toContain('Import failed')
	})

	it('returns failure for JS file without default export', async () => {
		fs.writeFileSync(nodePath.join(dir.root, 'nodefault.mjs'), 'export const x = 1;', 'utf8')

		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.import(nodePath.join(dir.root, 'nodefault.mjs'))
		expect(result.success).toBe(false)
		expect(result.message).toContain('No default export')
	})

	it('import via execute() works as management operation', async () => {
		writeJson(dir.root, 'via-exec.json', testDef('via-execute', 33))

		const tool = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
		})

		const result = await tool.execute({ import: nodePath.join(dir.root, 'via-exec.json') })
		const importResult = result as { success: boolean; id: string }
		expect(importResult.success).toBe(true)
		expect(importResult.id).toBe('via-execute')
		expect(tool.definitions().has('via-execute')).toBe(true)
	})

	it('imported definition survives across tool instances via stores', async () => {
		writeJson(dir.root, 'durable.json', testDef('durable-def', 99))

		const stores = storesFor({ path: storeDir.root })
		const tool1 = new ReasonTool({
			name: 'calc',
			summary: 'Calc',
			description: 'Calculate',
			reason,
			stores,
		})

		await tool1.import(nodePath.join(dir.root, 'durable.json'))
		expect(tool1.definitions().has('durable-def')).toBe(true)

		// Create a second tool from the same store directory
		const stores2 = storesFor({ path: storeDir.root })
		const tool2 = new ReasonTool({
			name: 'calc2',
			summary: 'Calc',
			description: 'Calculate2',
			reason,
			stores: stores2,
		})

		await tool2.init()
		expect(tool2.definitions().has('durable-def')).toBe(true)
		expect(
			quantitativeValue(await tool2.execute({ definitionId: 'durable-def', subject: {} })),
		).toBe(99)
	})
})

// === Schema Audit

describe('ReasonTool schema audit', () => {
	const reason = createReason({ reasoners: [createQuantitativeReasoner()] })
	const tool = new ReasonTool({ name: 'audit', summary: 'Audit', description: 'Audit', reason })
	const schema = tool.parameters
	const topProps = schema['properties'] as Record<string, Record<string, unknown>>

	it('top-level schema is type object', async () => {
		expect(schema['type']).toBe('object')
	})

	it('has no top-level required array (all params optional for management ops)', async () => {
		expect(schema['required']).toBeUndefined()
	})

	it('top-level properties include all expected keys', async () => {
		const expectedKeys = [
			'definitionId',
			'definition',
			'subject',
			'subjects',
			'memory',
			'persist',
			'forget',
			'import',
		]
		for (const key of expectedKeys) {
			expect(topProps[key]).toBeDefined()
		}
	})

	it('definitionId is type string', async () => {
		expect(topProps['definitionId']['type']).toBe('string')
	})

	it('definition is type object with required type, id, name', async () => {
		const def = topProps['definition']
		expect(def['type']).toBe('object')
		expect(def['required']).toEqual(['type', 'id', 'name'])
	})

	it('definition.type has enum with all four reasoning types', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		expect(defProps['type']['enum']).toEqual(['quantitative', 'logical', 'symbolic', 'inferential'])
	})

	it('groups is an array with items of type object', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		expect(defProps['groups']['type']).toBe('array')
		const items = defProps['groups']['items'] as Record<string, unknown>
		expect(items['type']).toBe('object')
	})

	it('rules is an array with items of type object', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		expect(defProps['rules']['type']).toBe('array')
		const items = defProps['rules']['items'] as Record<string, unknown>
		expect(items['type']).toBe('object')
	})

	it('equations is an array with items of type object', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		expect(defProps['equations']['type']).toBe('array')
		const items = defProps['equations']['items'] as Record<string, unknown>
		expect(items['type']).toBe('object')
	})

	it('facts is an array with items of type object', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		expect(defProps['facts']['type']).toBe('array')
		const items = defProps['facts']['items'] as Record<string, unknown>
		expect(items['type']).toBe('object')
	})

	it('inferences is an array with items of type object', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		expect(defProps['inferences']['type']).toBe('array')
		const items = defProps['inferences']['items'] as Record<string, unknown>
		expect(items['type']).toBe('object')
	})

	it('subject is type object with additionalProperties', async () => {
		expect(topProps['subject']['type']).toBe('object')
		expect(topProps['subject']['additionalProperties']).toBe(true)
	})

	it('subjects is an array with items of type object', async () => {
		expect(topProps['subjects']['type']).toBe('array')
		const items = topProps['subjects']['items'] as Record<string, unknown>
		expect(items['type']).toBe('object')
	})

	it('memory is type boolean', async () => {
		expect(topProps['memory']['type']).toBe('boolean')
	})

	it('persist is type boolean', async () => {
		expect(topProps['persist']['type']).toBe('boolean')
	})

	it('forget uses oneOf with string and boolean', async () => {
		const forget = topProps['forget']
		expect(forget['oneOf']).toBeDefined()
		const oneOf = forget['oneOf'] as Record<string, unknown>[]
		const types = oneOf.map((o) => o['type'])
		expect(types).toContain('string')
		expect(types).toContain('boolean')
	})

	it('import is type string', async () => {
		expect(topProps['import']['type']).toBe('string')
	})

	it('all array properties have items defined', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		const arrayFields = ['groups', 'rules', 'equations', 'facts', 'inferences']
		for (const field of arrayFields) {
			const fieldProp = defProps[field]
			expect(fieldProp['type']).toBe('array')
			expect(fieldProp['items']).toBeDefined()
		}
	})

	it('factors within groups have items defined', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		const groupItems = defProps['groups']['items'] as Record<string, unknown>
		const groupProps = groupItems['properties'] as Record<string, Record<string, unknown>>
		expect(groupProps['factors']['type']).toBe('array')
		expect(groupProps['factors']['items']).toBeDefined()
	})

	it('conditions within factors have items defined', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		const groupItems = defProps['groups']['items'] as Record<string, unknown>
		const groupProps = groupItems['properties'] as Record<string, Record<string, unknown>>
		const factorItems = groupProps['factors']['items'] as Record<string, unknown>
		const factorProps = factorItems['properties'] as Record<string, Record<string, unknown>>
		expect(factorProps['conditions']['type']).toBe('array')
		expect(factorProps['conditions']['items']).toBeDefined()
	})

	it('transforms within factors have items defined', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		const groupItems = defProps['groups']['items'] as Record<string, unknown>
		const groupProps = groupItems['properties'] as Record<string, Record<string, unknown>>
		const factorItems = groupProps['factors']['items'] as Record<string, unknown>
		const factorProps = factorItems['properties'] as Record<string, Record<string, unknown>>
		expect(factorProps['transforms']['type']).toBe('array')
		expect(factorProps['transforms']['items']).toBeDefined()
	})

	it('source within factors has required kind', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		const groupItems = defProps['groups']['items'] as Record<string, unknown>
		const groupProps = groupItems['properties'] as Record<string, Record<string, unknown>>
		const factorItems = groupProps['factors']['items'] as Record<string, unknown>
		const factorProps = factorItems['properties'] as Record<string, Record<string, unknown>>
		const source = factorProps['source']
		expect(source['required']).toEqual(['kind'])
	})

	it('ranges within source have items defined', async () => {
		const defProps = topProps['definition']['properties'] as Record<string, Record<string, unknown>>
		const groupItems = defProps['groups']['items'] as Record<string, unknown>
		const groupProps = groupItems['properties'] as Record<string, Record<string, unknown>>
		const factorItems = groupProps['factors']['items'] as Record<string, unknown>
		const factorProps = factorItems['properties'] as Record<string, Record<string, unknown>>
		const sourceProps = factorProps['source']['properties'] as Record<
			string,
			Record<string, unknown>
		>
		expect(sourceProps['ranges']['type']).toBe('array')
		expect(sourceProps['ranges']['items']).toBeDefined()
	})

	it('every description is a non-empty string', async () => {
		const descriptions: string[] = []
		function collectDescriptions(obj: unknown): void {
			if (typeof obj !== 'object' || obj === null) return
			const record = obj as Record<string, unknown>
			const desc = record['description']
			if (typeof desc === 'string') {
				descriptions.push(desc)
			}
			for (const [key, value] of Object.entries(record)) {
				if (key !== 'description' && typeof value === 'object' && value !== null) {
					collectDescriptions(value)
				}
			}
		}
		collectDescriptions(schema)
		expect(descriptions.length).toBeGreaterThan(0)
		for (const desc of descriptions) {
			expect(desc.length).toBeGreaterThan(0)
		}
	})

	it('passes deep recursive schema validation', async () => {
		const errors = validateSchema(schema)
		expect(errors).toEqual([])
	})
})
