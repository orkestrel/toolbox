import { afterEach, describe, expect, it } from 'vitest'
import { createInterpret } from '@orkestrel/interpret'
import { InterpretTool, createMCPStoreManager } from '@orkestrel/mcp'
import { testTemplate } from '../../setup.js'
import { validateSchema } from '../../setupServer.js'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'

describe('InterpretTool', () => {
	const insuranceTemplate = testTemplate({ domain: 'insurance', subDomains: ['auto'] })

	// Temp directory for store tests
	let tmpDir: string | undefined

	afterEach(() => {
		if (tmpDir && nodeFs.existsSync(tmpDir)) {
			nodeFs.rmSync(tmpDir, { recursive: true, force: true })
			tmpDir = undefined
		}
	})

	function makeTmpDir(): string {
		tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'interpret-tool-'))
		return tmpDir
	}

	function makeTool(templates = [insuranceTemplate]) {
		const interpreter = createInterpret({ session: 'tool-test', templates })
		return new InterpretTool({
			name: 'interpret',
			summary: 'Interpret',
			description: 'Natural language interpretation',
			interpreter,
		})
	}

	function makeToolWithStores(templates = [insuranceTemplate]) {
		const dir = makeTmpDir()
		const stores = createMCPStoreManager()
		stores.create({ path: dir })
		const interpreter = createInterpret({ session: 'store-test', templates })
		return new InterpretTool({
			name: 'interpret',
			summary: 'Interpret',
			description: 'Interpret with stores',
			interpreter,
			memory: true,
			stores,
		})
	}

	it('exposes name from input', () => {
		const tool = makeTool()
		expect(tool.name).toBe('interpret')
	})

	it('exposes description from input', () => {
		const tool = makeTool()
		expect(tool.description).toBe('Natural language interpretation')
	})

	it('exposes summary from input', () => {
		const tool = makeTool()
		expect(tool.summary).toBe('Interpret')
	})

	it('list returns registered template summaries', async () => {
		const tool = makeTool()
		await tool.init()
		const items = tool.list()
		expect(items).toHaveLength(1)
		expect(items[0].id).toBe(insuranceTemplate.id)
		expect(items[0].name).toBe(insuranceTemplate.name)
		expect(items[0].domain).toBe(insuranceTemplate.domain)
	})

	it('list returns empty array when no templates registered', () => {
		const tool = makeTool([])
		expect(tool.list()).toEqual([])
	})

	it('has parameters schema with operation', () => {
		const tool = makeTool()
		expect(tool.parameters).toBeDefined()
		expect(tool.parameters['type']).toBe('object')
		const props = tool.parameters['properties'] as Record<string, unknown>
		expect(props['operation']).toBeDefined()
	})

	it('init registers pending templates', async () => {
		const interpreter = createInterpret({ session: 'init-test' })
		const tool = new InterpretTool({
			name: 'interpret',
			summary: 'Interpret',
			description: 'Test',
			interpreter,
			templates: [insuranceTemplate],
		})

		expect(tool.templates().size).toBe(0)
		await tool.init()
		expect(tool.templates().size).toBe(1)
	})

	it('templates() returns registered templates', () => {
		const tool = makeTool()
		const templates = tool.templates()
		expect(templates.size).toBe(1)
		expect(templates.get('test-template')?.domain).toBe('insurance')
	})

	// === interpret operation

	it('interpret: runs full pipeline', async () => {
		const tool = makeTool()
		const result = await tool.execute({
			operation: 'interpret',
			input: 'calculate insurance age 25',
		})
		const r = result as Record<string, unknown>
		expect(r['original']).toBe('calculate insurance age 25')
		expect(r['prompt']).toBeDefined()
		expect((r['stages'] as unknown[])?.length).toBe(5)
	})

	it('interpret: returns error for missing input', async () => {
		const tool = makeTool()
		const result = await tool.execute({ operation: 'interpret' })
		const r = result as Record<string, unknown>
		expect(r['error']).toContain('input')
	})

	it('interpret: returns error for empty input', async () => {
		const tool = makeTool()
		const result = await tool.execute({ operation: 'interpret', input: '' })
		const r = result as Record<string, unknown>
		expect(r['error']).toContain('input')
	})

	it('interpret: handles unrecognized domain', async () => {
		const tool = makeTool([])
		const result = await tool.execute({ operation: 'interpret', input: 'something random' })
		const r = result as Record<string, unknown>
		expect(r['complete']).toBe(false)
		expect(r['confidence']).toBe(0)
	})

	// === describe operation

	it('describe: produces prompt from subject and definition', async () => {
		const tool = makeTool()
		const result = await tool.execute({
			operation: 'describe',
			subject: { age: 25, amount: 500 },
			definition: {
				type: 'quantitative',
				id: 'test-template',
				name: 'Test Template',
				groups: [],
				aggregation: 'sum',
			},
		})
		const r = result as Record<string, unknown>
		expect(typeof r['prompt']).toBe('string')
		expect(r['template']).toBe('test-template')
	})

	it('describe: returns error for missing subject', async () => {
		const tool = makeTool()
		const result = await tool.execute({
			operation: 'describe',
			definition: { type: 'quantitative', id: 'x', name: 'X', groups: [], aggregation: 'sum' },
		})
		const r = result as Record<string, unknown>
		expect(r['error']).toContain('subject')
	})

	it('describe: returns error for missing definition', async () => {
		const tool = makeTool()
		const result = await tool.execute({
			operation: 'describe',
			subject: { age: 25 },
		})
		const r = result as Record<string, unknown>
		expect(r['error']).toContain('definition')
	})

	it('describe: returns error for invalid definition', async () => {
		const tool = makeTool()
		const result = await tool.execute({
			operation: 'describe',
			subject: { age: 25 },
			definition: { invalid: true },
		})
		const r = result as Record<string, unknown>
		expect(r['error']).toBeDefined()
	})

	// === normalize operation

	it('normalize: normalizes input text', async () => {
		const tool = makeTool()
		const result = await tool.execute({ operation: 'normalize', input: "what's my rate" })
		const r = result as Record<string, unknown>
		expect(r['text']).toContain('what is')
		expect(typeof r['changes']).toBe('number')
		expect(typeof r['duration']).toBe('number')
	})

	it('normalize: returns error for missing input', async () => {
		const tool = makeTool()
		const result = await tool.execute({ operation: 'normalize' })
		const r = result as Record<string, unknown>
		expect(r['error']).toContain('input')
	})

	// === parse operation

	it('parse: parses input and extracts intent', async () => {
		const tool = makeTool()
		const result = await tool.execute({ operation: 'parse', input: 'calculate insurance' })
		const r = result as Record<string, unknown>
		expect(r['intent']).toBeDefined()
		expect((r['intent'] as Record<string, unknown>)['action']).toBe('calculate')
		expect(typeof r['complete']).toBe('boolean')
	})

	it('parse: returns error for missing input', async () => {
		const tool = makeTool()
		const result = await tool.execute({ operation: 'parse' })
		const r = result as Record<string, unknown>
		expect(r['error']).toContain('input')
	})

	// === templates operation

	it('templates: lists registered templates', async () => {
		const tool = makeTool()
		const result = await tool.execute({ operation: 'templates' })
		const r = result as Record<string, unknown>
		const templates = r['templates'] as unknown[]
		expect(templates).toHaveLength(1)
		const first = templates[0] as Record<string, unknown>
		expect(first['id']).toBe('test-template')
		expect(first['domain']).toBe('insurance')
	})

	it('templates: returns empty list when none registered', async () => {
		const tool = makeTool([])
		const result = await tool.execute({ operation: 'templates' })
		const r = result as Record<string, unknown>
		expect((r['templates'] as unknown[])?.length).toBe(0)
	})

	// === error cases

	it('returns error for missing operation', async () => {
		const tool = makeTool()
		const result = await tool.execute({})
		const r = result as Record<string, unknown>
		expect(r['error']).toContain('operation')
	})

	it('returns error for unknown operation', async () => {
		const tool = makeTool()
		const result = await tool.execute({ operation: 'unknown' })
		const r = result as Record<string, unknown>
		expect(r['error']).toContain('unknown')
	})

	it('returns error for non-string operation', async () => {
		const tool = makeTool()
		const result = await tool.execute({ operation: 42 })
		const r = result as Record<string, unknown>
		expect(r['error']).toContain('operation')
	})

	// === stores property

	it('stores is undefined when not provided', () => {
		const tool = makeTool()
		expect(tool.stores).toBeUndefined()
	})

	it('stores is set when provided', () => {
		const tool = makeToolWithStores()
		expect(tool.stores).toBeDefined()
	})

	// === forget operation

	it('forget: removes all templates via execute', async () => {
		const tool = makeTool()
		expect(tool.templates().size).toBe(1)
		const result = await tool.execute({ forget: true })
		const r = result as Record<string, unknown>
		expect(r['success']).toBe(true)
		expect(r['message']).toContain('All templates removed')
		// Verify templates are actually removed from the interpreter
		expect(tool.templates().size).toBe(0)
	})

	it('forget: removes one template by id via execute', async () => {
		const tool = makeTool()
		expect(tool.templates().size).toBe(1)
		const result = await tool.execute({ forget: 'test-template' })
		const r = result as Record<string, unknown>
		expect(r['success']).toBe(true)
		expect(r['message']).toContain('test-template')
		// Verify template is actually removed from the interpreter
		expect(tool.templates().has('test-template')).toBe(false)
	})

	it('forget: returns invalid error for non-string non-boolean', async () => {
		const tool = makeTool()
		const result = await tool.execute({ forget: 42 })
		const r = result as Record<string, unknown>
		expect(r['success']).toBe(false)
		expect(r['message']).toContain('Invalid')
	})

	it('forget: takes priority over operation', async () => {
		const tool = makeTool()
		const result = await tool.execute({ forget: true, operation: 'templates' })
		const r = result as Record<string, unknown>
		expect(r['success']).toBe(true)
	})

	it('forget: removes from stores too', async () => {
		const tool = makeToolWithStores()
		await tool.init()
		// Create a temp file to import (outside the store dir)
		const tempFile = nodePath.join(nodeOs.tmpdir(), 'forget-test-tmpl.json')
		nodeFs.writeFileSync(
			tempFile,
			JSON.stringify({
				id: 'persist-test',
				name: 'Persist Test',
				domain: 'test',
				intents: ['calculate'],
				mappings: [],
				defaults: [],
				inferences: [],
				definition: {
					type: 'quantitative',
					id: 'persist-test',
					name: 'Persist Test',
					groups: [],
					aggregation: 'sum',
				},
			}),
		)
		try {
			await tool.import(tempFile)
			// Verify it was persisted to the store — stores is guaranteed by makeToolWithStores
			const stores = tool.stores
			expect(stores).toBeDefined()
			const storeList = stores?.stores() ?? []
			expect(storeList[0]?.entry('persist-test')).toBeDefined()

			await tool.execute({ forget: 'persist-test' })
			// Verify the store's underlying file entry was removed
			expect(storeList[0]?.entry('persist-test')).toBeUndefined()
		} finally {
			if (nodeFs.existsSync(tempFile)) nodeFs.unlinkSync(tempFile)
		}
	})

	// === import operation

	it('import: imports a JSON template file', async () => {
		const dir = makeTmpDir()
		const file = nodePath.join(dir, 'tmpl.json')
		nodeFs.writeFileSync(
			file,
			JSON.stringify({
				id: 'imported-tmpl',
				name: 'Imported Template',
				domain: 'test',
				intents: ['calculate'],
				mappings: [],
				defaults: [],
				inferences: [],
				definition: {
					type: 'quantitative',
					id: 'imported-tmpl',
					name: 'Imported',
					groups: [],
					aggregation: 'sum',
				},
			}),
		)
		const tool = makeTool([])
		const result = await tool.import(file)
		expect(result.success).toBe(true)
		expect(result.id).toBe('imported-tmpl')
		expect(tool.templates().has('imported-tmpl')).toBe(true)
	})

	it('import: returns failure for missing file', async () => {
		const tool = makeTool()
		const result = await tool.import('/nonexistent/file.json')
		expect(result.success).toBe(false)
		expect(result.message).toContain('not found')
	})

	it('import: returns failure for unsupported extension', async () => {
		const tool = makeTool()
		const result = await tool.import('/some/file.txt')
		expect(result.success).toBe(false)
		expect(result.message).toContain('Unsupported')
	})

	it('import: returns failure for invalid JSON content', async () => {
		const dir = makeTmpDir()
		const file = nodePath.join(dir, 'bad.json')
		nodeFs.writeFileSync(file, '{"id": "nope"}')
		const tool = makeTool()
		const result = await tool.import(file)
		expect(result.success).toBe(false)
		expect(result.message).toContain('valid InterpretTemplate')
	})

	it('import: via execute dispatches to import handler', async () => {
		const dir = makeTmpDir()
		const file = nodePath.join(dir, 'tmpl.json')
		nodeFs.writeFileSync(
			file,
			JSON.stringify({
				id: 'exec-import',
				name: 'Exec Import',
				domain: 'test',
				intents: ['check'],
				mappings: [],
				defaults: [],
				inferences: [],
				definition: {
					type: 'logical',
					id: 'exec-import',
					name: 'Exec Import',
					rules: [],
					strategy: 'forward',
				},
			}),
		)
		const tool = makeTool([])
		const result = await tool.execute({ import: file })
		const r = result as Record<string, unknown>
		expect(r['success']).toBe(true)
		expect(r['id']).toBe('exec-import')
	})

	it('import: takes priority over operation', async () => {
		const dir = makeTmpDir()
		const file = nodePath.join(dir, 'tmpl.json')
		nodeFs.writeFileSync(
			file,
			JSON.stringify({
				id: 'priority-test',
				name: 'Priority',
				domain: 'test',
				intents: ['calculate'],
				mappings: [],
				defaults: [],
				inferences: [],
				definition: {
					type: 'quantitative',
					id: 'priority-test',
					name: 'Priority',
					groups: [],
					aggregation: 'sum',
				},
			}),
		)
		const tool = makeTool([])
		const result = await tool.execute({ import: file, operation: 'templates' })
		const r = result as Record<string, unknown>
		expect(r['success']).toBe(true)
	})

	// === persistence with stores

	it('persists imported template to store when memory is true', async () => {
		const tool = makeToolWithStores()
		await tool.init()
		const dir = makeTmpDir()
		const file = nodePath.join(dir, 'tmpl.json')
		nodeFs.writeFileSync(
			file,
			JSON.stringify({
				id: 'persisted-tmpl',
				name: 'Persisted',
				domain: 'test',
				intents: ['calculate'],
				mappings: [],
				defaults: [],
				inferences: [],
				definition: {
					type: 'quantitative',
					id: 'persisted-tmpl',
					name: 'Persisted',
					groups: [],
					aggregation: 'sum',
				},
			}),
		)
		await tool.import(file)
		// Verify it was written to the store — stores is guaranteed by makeToolWithStores
		const stores = tool.stores
		expect(stores).toBeDefined()
		const entry = stores?.entry('persisted-tmpl')
		expect(entry).toBeDefined()
		expect(entry?.data['id']).toBe('persisted-tmpl')
	})

	it('does not persist when memory is false', async () => {
		const dir = makeTmpDir()
		const stores = createMCPStoreManager()
		stores.create({ path: dir })
		const interpreter = createInterpret({ session: 'no-persist' })
		const tool = new InterpretTool({
			name: 'interpret',
			summary: 'Interpret',
			description: 'No persist',
			interpreter,
			memory: false,
			stores,
		})

		const tmpDir2 = makeTmpDir()
		const file = nodePath.join(tmpDir2, 'tmpl.json')
		nodeFs.writeFileSync(
			file,
			JSON.stringify({
				id: 'no-persist-tmpl',
				name: 'No Persist',
				domain: 'test',
				intents: ['calculate'],
				mappings: [],
				defaults: [],
				inferences: [],
				definition: {
					type: 'quantitative',
					id: 'no-persist-tmpl',
					name: 'NP',
					groups: [],
					aggregation: 'sum',
				},
			}),
		)
		await tool.import(file)
		const entry = stores.entry('no-persist-tmpl')
		expect(entry).toBeUndefined()
	})

	it('init loads templates from stores', async () => {
		const dir = makeTmpDir()
		// Pre-write a template file to the store directory
		nodeFs.writeFileSync(
			nodePath.join(dir, 'stored-tmpl.json'),
			JSON.stringify({
				id: 'stored-tmpl',
				name: 'Stored Template',
				domain: 'finance',
				intents: ['calculate'],
				mappings: [],
				defaults: [],
				inferences: [],
				definition: {
					type: 'quantitative',
					id: 'stored-tmpl',
					name: 'Stored',
					groups: [],
					aggregation: 'sum',
				},
			}),
		)
		const stores = createMCPStoreManager()
		stores.create({ path: dir })
		const interpreter = createInterpret({ session: 'load-test' })
		const tool = new InterpretTool({
			name: 'interpret',
			summary: 'Interpret',
			description: 'Load from stores',
			interpreter,
			memory: true,
			stores,
		})

		expect(tool.templates().size).toBe(0)
		await tool.init()
		expect(tool.templates().has('stored-tmpl')).toBe(true)
	})

	// === Schema Audit

	describe('schema audit', () => {
		it('top-level schema is type object', () => {
			const tool = makeTool()
			expect(tool.parameters['type']).toBe('object')
		})

		it('has no required array (all params optional for management ops)', () => {
			const tool = makeTool()
			expect(tool.parameters['required']).toBeUndefined()
		})

		it('top-level properties include all expected keys', () => {
			const tool = makeTool()
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const expectedKeys = ['operation', 'input', 'subject', 'definition', 'forget', 'import']
			for (const key of expectedKeys) {
				expect(props[key]).toBeDefined()
			}
		})

		it('operation has enum with all five operations', () => {
			const tool = makeTool()
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const operations = props['operation']['enum'] as string[]
			expect(operations).toEqual(['interpret', 'describe', 'normalize', 'parse', 'templates'])
		})

		it('input is type string', () => {
			const tool = makeTool()
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			expect(props['input']['type']).toBe('string')
		})

		it('subject is type object with additionalProperties', () => {
			const tool = makeTool()
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			expect(props['subject']['type']).toBe('object')
			expect(props['subject']['additionalProperties']).toBe(true)
		})

		it('definition is type object with additionalProperties', () => {
			const tool = makeTool()
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			expect(props['definition']['type']).toBe('object')
			expect(props['definition']['additionalProperties']).toBe(true)
		})

		it('forget uses oneOf with string and boolean', () => {
			const tool = makeTool()
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const forget = props['forget']
			expect(forget['oneOf']).toBeDefined()
			const oneOf = forget['oneOf'] as Record<string, unknown>[]
			const types = oneOf.map((o) => o['type'])
			expect(types).toContain('string')
			expect(types).toContain('boolean')
		})

		it('import is type string', () => {
			const tool = makeTool()
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			expect(props['import']['type']).toBe('string')
		})

		it('every property has a description', () => {
			const tool = makeTool()
			const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
			const descriptions = Object.values(props)
				.map((value) => value['description'])
				.filter((d): d is string => typeof d === 'string')
			expect(descriptions.length).toBeGreaterThan(0)
			for (const desc of descriptions) {
				expect(desc.length).toBeGreaterThan(0)
			}
		})

		it('passes deep recursive schema validation', () => {
			const tool = makeTool()
			const errors = validateSchema(tool.parameters)
			expect(errors).toEqual([])
		})
	})
})
