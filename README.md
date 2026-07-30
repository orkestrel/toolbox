# @orkestrel/tool

Concrete, LLM-callable **tools** for the `@orkestrel` line — built over
[`@orkestrel/agent`](https://github.com/orkestrel/agent)'s `ToolInterface` /
`createTool` runtime, with pluggable stores. Part of the `@orkestrel` line.

- **`createWorkflowTool`** — authors and runs an
  [`@orkestrel/workflow`](https://github.com/orkestrel/workflow) definition in
  one call (flat steps / lenient draft / full definition, depth + cycle
  guarded), with an optional pluggable `WorkflowStoreInterface` that persists
  each executed run's snapshot on settle.
- **`createWorkspaceTool`** — a 13-operation workspace-editing tool driving
  `@orkestrel/agent`'s workspace runtime, either against a caller-supplied
  manager or a fresh one built over a pluggable `WorkspaceStoreInterface`.
- **`createAgentTool`** — net-new sub-agent delegation: resolves and runs one
  seeded agent via an `AgentRegistryInterface`, depth + cycle guarded,
  deliberately storeless (persistence, if any, rides the registry's own
  configuration).
- **Adapters** — `createToolFunction` / `createAgentFunction` compose a
  registered tool or a live agent into a workflow's `functions` registry, plus
  the authoring umbrella (`WorkflowSteps` / `WorkflowDraft`,
  `createWorkflowDraftContract`, `workflowToolSummary`, `MAX_WORKFLOW_DEPTH`).

**Status: v0.0.1 pending publish**, once the upstream `@orkestrel/workflow` /
`@orkestrel/agent` cleanups that drop their authoring surfaces (this package
becomes the defining home) land.

## Install

```sh
npm install @orkestrel/tool
```

## Requirements

- Node.js >= 22
- Dual ESM + CommonJS builds (`import` and `require` both supported)

## Guide

See [`guides/src/tool.md`](guides/src/tool.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
