# Adding an Agent Harness Adapter

This is a documentation stub for adding support for a new local agent harness.

An adapter should explain:

- Where the harness stores local session transcripts.
- How sessions are discovered and sorted.
- How raw transcript records map into the shared trace topology.
- How tool calls, subagents, prompts, token usage, and attachments are represented.
- Which fields are structural identifiers and which fields are display-only.
- What fixtures and tests prove the adapter works.

Adapter implementations should keep the same local-only contract as the rest of agent-profiler: read local files on demand, avoid background collectors, and never send transcript data off the machine.

For the existing pipeline and invariants, start with [ARCHITECTURE.md](../ARCHITECTURE.md).
