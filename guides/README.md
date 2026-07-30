# Guides

A dual-axis index into this repository's guides — by concept, and by directory (AGENTS §22).

## By concept

| Concept | Spec                         | Source                                                   | Tests                                                                            |
| ------- | ---------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Tool    | [`src/tool.md`](src/tool.md) | [`src/core`](../src/core), [`src/server`](../src/server) | [`tests/src/core`](../tests/src/core), [`tests/src/server`](../tests/src/server) |

## By directory

| Directory    | Guide                        |
| ------------ | ---------------------------- |
| `src/core`   | [`src/tool.md`](src/tool.md) |
| `src/server` | [`src/tool.md`](src/tool.md) |

## Dependency reference

[`src/agent.md`](src/agent.md) is a byte-identical mirror of the guide for
`@orkestrel/agent` — a runtime dependency, the tool runtime (`ToolInterface`,
`createTool`, `ToolManager`) this package's concrete tools plug into. It
documents **that package's** surface, not anything sourced in this repo; it
is kept here so a reader of this package can see the runtime it is built
from without leaving this guide set.

[`src/contract.md`](src/contract.md) is a byte-identical mirror of the guide
for `@orkestrel/contract` — a runtime dependency, the shape DSL a tool's
`operation`-discriminated contract compiles through. It documents **that
package's** surface (guards, combinators, parsers, and the shape DSL), not
anything sourced in this repo; it is kept here so a reader of this package
can see the primitives it is built from without leaving this guide set.

[`src/workflow.md`](src/workflow.md) is a byte-identical mirror of the guide
for `@orkestrel/workflow` — a runtime dependency, the workflow primitives the
workflow-authoring tool wraps. It documents **that package's** surface, not
anything sourced in this repo; it is kept here for the same reason.

[`src/guide.md`](src/guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity
test suite (`tests/guides/src/parity.test.ts`). It documents **that
package's** surface (`Guide` / `Source`, the manifest and comparison
helpers), not anything sourced in this repo; it is kept here so a reader of
the parity suite can see the primitives it is built from without leaving
this guide set.

[`src/database.md`](src/database.md) is a byte-identical mirror of the guide
for `@orkestrel/database` — a runtime dependency, the typed database layer
(`DatabaseInterface`, `DriverInterface`, `KeyFunction`, the `Criteria` /
`Condition` query DSL) `createDatabaseTool` wraps. It documents **that
package's** surface, not anything sourced in this repo; it is kept here so a
reader of this package can see the primitives it is built from without
leaving this guide set.

[`src/relation.md`](src/relation.md) is a byte-identical mirror of the guide
for `@orkestrel/relation` — a runtime dependency, the declarative ORM layer
(`RelationManagerInterface`, `ModelInterface`, `Include`) `createRelationTool`
wraps. It documents **that package's** surface, not anything sourced in this
repo; it is kept here for the same reason.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
