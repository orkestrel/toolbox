# Guides

A dual-axis index into this repository's guides — by concept, and by directory under AGENTS' documentation contract.

## By concept

| Concept | Spec                               | Source                                                   | Tests                                                                            |
| ------- | ---------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Toolbox | [`toolbox.md`](toolbox.md) | [`src/core`](../src/core), [`src/server`](../src/server) | [`tests/src/core`](../tests/src/core), [`tests/src/server`](../tests/src/server) |

## By directory

| Directory    | Guide                              |
| ------------ | ---------------------------------- |
| `src/core`   | [`toolbox.md`](toolbox.md) |
| `src/server` | [`toolbox.md`](toolbox.md) |

## Dependency reference

[`agent.md`](agent.md) is a byte-identical mirror of the guide for
`@orkestrel/agent` — a runtime dependency supplying the agent, conversation,
and delegation surfaces this package's concrete tools drive. It documents
**that package's** surface, not anything sourced in this repo.

[`workspace.md`](workspace.md) is a byte-identical mirror of the guide
for `@orkestrel/workspace` — the runtime dependency supplying the workspace,
file, manager, and store surfaces this package's workspace tool drives. It
documents **that package's** surface, not anything sourced in this repo.

[`tool.md`](tool.md) is a byte-identical mirror of the guide for
`@orkestrel/tool` — the runtime dependency supplying `ToolInterface`,
`createTool`, `ToolManager`, and the call/result envelope this package's
concrete tools plug into. It documents **that package's** surface, not
anything sourced in this repo.

[`contract.md`](contract.md) is a byte-identical mirror of the guide
for `@orkestrel/contract` — a runtime dependency, the shape DSL a tool's
`operation`-discriminated contract compiles through. It documents **that
package's** surface (guards, combinators, parsers, and the shape DSL), not
anything sourced in this repo; it is kept here so a reader of this package
can see the primitives it is built from without leaving this guide set.

[`workflow.md`](workflow.md) is a byte-identical mirror of the guide
for `@orkestrel/workflow` — a runtime dependency, the workflow primitives the
workflow-authoring tool wraps. It documents **that package's** surface, not
anything sourced in this repo; it is kept here for the same reason.

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity
test suite (`tests/guides.test.ts`). It documents **that
package's** surface (`Guide` / `Source`, the manifest and comparison
helpers), not anything sourced in this repo; it is kept here so a reader of
the parity suite can see the primitives it is built from without leaving
this guide set.

[`database.md`](database.md) is a byte-identical mirror of the guide
for `@orkestrel/database` — a runtime dependency, the typed database layer
(`DatabaseInterface`, `DriverInterface`, `KeyFunction`, the `QueryInput` /
`Condition` query DSL) `createDatabaseTool` wraps. It documents **that
package's** surface, not anything sourced in this repo; it is kept here so a
reader of this package can see the primitives it is built from without
leaving this guide set.

[`relation.md`](relation.md) is a byte-identical mirror of the guide
for `@orkestrel/relation` — a runtime dependency, the declarative ORM layer
(`RelationManagerInterface`, `ModelInterface`, `Include`) `createRelationTool`
wraps. It documents **that package's** surface, not anything sourced in this
repo; it is kept here for the same reason.

[`server.md`](server.md) is a byte-identical mirror of the guide for
`@orkestrel/server` — a runtime dependency supplying the SSE stream primitive
used by this package's terminal routes.

[`terminal.md`](terminal.md) is a byte-identical mirror of the guide for
`@orkestrel/terminal` — a runtime dependency supplying the prompt manager and
client surfaces this package's terminal tools and routes drive.

[`scaffold.md`](scaffold.md) is a byte-identical mirror of the guide for
`@orkestrel/scaffold` — the devDependency supplying this repository's
workspace-blueprint and policy infrastructure.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; documentation is an enforced contract.
