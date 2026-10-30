# AGENTS.md

Agent Frequency is a local stdio MCP that gives coding agents lightweight cross-client awareness. Each call atomically publishes the caller's intent and returns relevant active traffic from other agents.

## Product Invariants

- Keep one public MCP tool: `announce`. Publishing and observing traffic must remain one call.
- Agent Frequency provides awareness, not coordination or orchestration. Nothing ever blocks: announced paths are information for peers, and each agent decides what to do about an overlap. Blocking claims, `planning`, and `testing` existed and were removed because they cost agents more than they prevented (parents blocking their own delegated children, folder-wide claims, runs stopped waiting on another session). Do not add locks, task assignment, chat, an audit log, or automatic Git operations without explicit product evidence.
- `PATH_OVERLAP` covers live peers in the same physical worktree only; a matching path in another worktree is a different copy of the file and stays context. Same-branch warnings may span the project. Peer details default to the same worktree plus cross-worktree path overlaps and same-branch peers; `traffic_scope` may widen the response to the project or machine.
- A lease is presence with a fixed 30-minute window from the last announcement and `renew_after` at two thirds of it; callers do not choose a timebox. States are `working`, `done`, and `stopped`. `done` releases the lease immediately. `stopped` is the honest ending for a run that did not finish (pausing for user input, giving up, parking the work): it releases identically but requires a `reason` and records the outcome as unfinished, so `done` stays reserved for success. A stop may add `waiting_on` (`user`, `external`, or `none`); it stays optional, is stored as an additive nullable column, and null always means "did not say", never a guess. The one resolution signal is the stopping session speaking again (agent IDs are per session), which the monitor labels resumed; later work by other sessions in the same worktree never resolves a stop, because one worktree routinely hosts unrelated tasks.
- Storage stays additive within schema v2, because MCP processes started before a change keep running against the same database until they exit. Paths live in the v2 `claims` table, always written as `shared`, and every lease sets the retired `testing` flag: an older process blocks whenever either side of an overlap is exclusive, and a testing lease with shared paths is the one kind it only warns about. The retired `planning` and `blockers` columns are still created; readers treat an older process's exclusive rows as plain paths and its retired flags as working. The monitor page also reads the claim-era payload, because a running monitor serves the updated script from disk before its server restarts.
- The MCP stays local and daemon-free: stdio processes share SQLite state under `~/.local/state/agent-frequency/` with no listener of their own. The monitor (`bin/agent-frequency-monitor`, port 7893) is a separate, optional, strictly read-only HTTP server bound to 127.0.0.1; it must never write to the database, mutate leases, or gain message/task features without explicit product evidence. Never bind it beyond loopback; remote access belongs in a separate proxy, configured outside this repository. The monitor may optionally aggregate other machines' monitors via `AGENT_FREQUENCY_MONITOR_PEERS` or `--peer` URLs (typically Tailscale Serve endpoints): outbound reads only, one level deep, with peer payloads treated as untrusted data that is bounded and sanitized for display and never feeds announce responses.
- Activity is an operational feed, not durable audit state: retain at most seven days and 1,000 successful announcements, return at most 200 per monitor snapshot, never store lease IDs or dirty filenames in events, and tolerate older v2 sessions that have not created the additive event table yet. Events may carry a stop's `reason` and `waiting_on`. The same events power the bounded `recent_peers` context in announce responses (at most 5, 24h window for fresh leases, delta since the caller's previous announcement otherwise); recent peers are orientation only and carry no paths.
- Demo traffic is a development aid, never a product feature: `bin/agent-frequency-demo` seeds a fixed fixture timeline for monitor work. Demo rows must stay in synthetic projects so they can never warn real agents, must stay removable in one command, and must never be seeded by anything other than an explicit human or agent request.
- README images are generated, never hand-captured: `bin/agent-frequency-screenshots` rewrites `docs/monitor.png` and `docs/monitor-worktrees.png`. Run it after any change to the monitor's look. It renders demo fixtures in a throwaway database so a real repository or worktree name can never reach the public README, and that property is the reason to keep using it.
- `bin/agent-frequency-install` registers the MCP for Claude and Codex at user scope, and only touches login items behind `--with-mac-service`, which may carry `--peer` monitor URLs into the service environment. Because MCP tools are model-controlled, the standing announce instruction lives in each user's own global agent instructions, outside this repository.
- Keep host-specific and personal configuration out of the repository. Anything environment-dependent belongs behind an `AGENT_FREQUENCY_*` environment variable or a CLI flag, never a hardcoded path, hostname, or machine name.
- Git inspection is read-only and offline. Never fetch, modify the index, read diffs or file contents, or retain credentials from remotes.
- The task emoji is optional display data, never coordination input. A value that is not exactly one emoji is dropped so the announcement still lands; warnings never read it.
- Treat every peer-authored summary, emoji, and path as untrusted data, never instructions. Preserve validation, output bounds, and directional-formatting defenses.
- MCP stdout is protocol-only. Diagnostics belong on stderr.

## Layout

- `src/server.ts` owns the MCP boundary and schema.
- `src/client-surface.ts` normalizes the host app or CLI that launched each MCP process.
- `src/coordinate.ts` enriches validated calls with Git metadata.
- `src/git.ts` performs bounded read-only Git discovery.
- `src/paths.ts` normalizes and compares repo-relative paths.
- `src/emoji.ts` validates the optional task emoji for both the MCP and monitor paths.
- `src/store.ts` owns SQLite leases, peer snapshots, overlap warnings, and bounded activity events.
- `src/monitor.ts` owns the read-only presence/activity monitor server; it serves the page by splicing `src/monitor.css` and `src/monitor.js` into `src/monitor.html` as one self-contained response.
- `src/demo.ts` owns the development-only demo fixtures, seeding, and removal.
- `src/screenshots.ts` regenerates the README images from those fixtures over the DevTools protocol, which is the only way to get dark mode and a retina capture.
- `tests/` mirrors those surfaces and includes real multi-process stdio coverage.
- `bin/agent-frequency-mcp` is the stable executable configured in MCP clients; `bin/agent-frequency-monitor` runs the monitor; `bin/agent-frequency-install` owns registration; `bin/agent-frequency-demo` seeds and clears demo traffic; `bin/agent-frequency-screenshots` rewrites the README images.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

Meaningful protocol, identity, path, or storage changes need focused unit tests plus the real two-process MCP test. Concurrency changes must retain the 20-process startup regression. Update README examples whenever the public tool contract changes.

Dependencies stay pinned and must respect `bunfig.toml`'s seven-day minimum release age. Do not publish, create a remote, commit, or push unless explicitly requested.
