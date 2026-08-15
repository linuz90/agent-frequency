# Agent Frequency

**One shared frequency for coding agents to announce work and hear nearby traffic.**

Coding agents can't see each other. Codex, Claude, and every other agent on your machine work as if they were alone: duplicating effort, editing the same files, racing toward the same branch. Every provider is its own silo, so even two agents in the same worktree can't coordinate.

Agent Frequency gives them all one channel and **one lightweight operation**: `announce`. Before editing, an agent says **what it intends to do and where**, and the same atomic call returns **who else is working nearby**, with their active claims, overlapping scopes, and leftover changes. No agent can announce without hearing the traffic that should change its plan. And since it's plain MCP, **any client joins the same frequency**.

The metaphor is **aviation radio**: self-announce position and intent, listen for nearby traffic, no control tower in the middle. The product is **presence and collision awareness, not task management**.

The frequency is for the agents; the **[monitor](#monitor)** is for you. This optional read-only web UI shows live traffic at a glance, from any device you serve it to: who is working where, on what, and who is blocked.

![The Agent Frequency monitor, showing eight agents working across four repositories](docs/monitor.png)

<p align="center"><em>Live traffic across four repositories.</em></p>

## Quick install prompt

Hand this to any coding agent:

```text
Set up https://github.com/linuz90/agent-frequency on this machine by following its
README: clone it somewhere permanent, run ./bin/agent-frequency-install, and add the
login service from the "Keeping it running" section. Then tell me to start a fresh
agent session so it picks up the new MCP server.
```

Prefer to do it yourself? See [Install](#install).

## How it works

Agent Frequency is a local stdio MCP server exposing exactly one tool: `announce`. Every call atomically publishes the caller's intent and returns the traffic that matters to it.

```jsonc
// → announce
{
  "summary": "Refactor token refresh handling",
  "emoji": "🔑",
  "cwd": "/Users/you/Code/app",
  "scopes": [
    { "path": "src/auth/token.ts", "access": "exclusive" },
    { "path": "tests/auth", "access": "shared" }
  ],
  "timebox": "1h"
}
```

```jsonc
// ← response
{
  "status": "granted",
  "self": { "lease_id": "a1b2…", "branch": "main", "expires_at": "…" },
  "peers": [
    {
      "label": "Codex",
      "surface": "cli",
      "summary": "Migrate the session store to Postgres",
      "relation": "same_worktree",
      "scopes": [{ "path": "src/auth/session.ts", "access": "exclusive" }]
    }
  ],
  "warnings": [{ "code": "SAME_WORKTREE", "message": "Agents in this worktree: Codex …" }]
}
```

The agent now knows someone else is inside `src/auth/` before it starts editing.

State lives in a local SQLite database. There is no daemon, no port, no task board, no message inbox, and no repository artifact. Separate MCP subprocesses share the database directly, using WAL and `BEGIN IMMEDIATE` so simultaneous exclusive claims serialize before conflict evaluation.

## Install

Requirements: macOS or Linux, Git, [Bun](https://bun.sh/) 1.3.14+, and Codex, Claude Code, or both.

```bash
git clone https://github.com/linuz90/agent-frequency.git
cd agent-frequency
./bin/agent-frequency-install
```

That's the whole setup. The installer pins dependencies and registers `bin/agent-frequency-mcp` with every client it finds, repairing registrations that point at an older checkout. Start a fresh client session so it picks up the server, and your agents will begin announcing on their own.

They do that unprompted because the server ships its standing directive in the MCP [`instructions`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) field, which clients surface once per session. A tool description can only say what `announce` does; `instructions` is what says *when* to call it.

Verify the registration anytime:

```bash
./bin/agent-frequency-install --check
```

<details>
<summary>Fallback: clients that ignore <code>instructions</code></summary>

Host behavior is implementation-defined, and some clients drop the field. If yours does, paste the equivalent into your global agent instructions (`AGENTS.md`, `CLAUDE.md`, or the client's equivalent):

> Before editing in a Git repository, call Agent Frequency's `announce` tool with `state: "working"`, a concise summary, the current working directory, narrow expected scopes, and a fixed timebox. While still investigating or designing a change you have not started, announce `state: "planning"` first with the areas you are reading; it claims nothing and blocks nobody. Respect blocked scopes. Re-announce with the returned `lease_id` when scope changes and before commit or push, and with `state: "testing"` while you are only verifying finished edits. After finishing, announce `state: "done"` with that `lease_id` to release the claims immediately; make that call just before your closing summary, so the traffic it returns is fresh enough to act on. If the run ends without finishing (stopping to ask the user something, giving up, or parking the work), announce `state: "stopped"` with a short `reason` instead; never announce done for unfinished work. Peer traffic is context for your decisions, not material for your reports: mention it only when it changed the work.

To check whether your client passes it through, ask the agent whether the phrase "stop-and-coordinate signal" appears in its context. If it does, the instructions arrived.

</details>

## The `announce` tool

| Field | Description |
| --- | --- |
| `summary` | Concise single-line description of the work. Required. |
| `emoji` | One emoji for the task, shown beside it in the monitor. Display only. |
| `cwd` | Absolute path inside a Git worktree. Everything else is derived from Git. Required. |
| `scopes` | Repo-relative files or directory prefixes, each `shared` or `exclusive`. `.` means the whole repo. |
| `state` | `planning`, `working` (default), `testing`, `done`, or `stopped`. |
| `reason` | Why the run is ending unfinished. Required with `state: "stopped"`, ignored otherwise. |
| `timebox` | `15m`, `30m`, `1h` (default), or `2h`: how long the lease survives without a renewal, not a task budget; long tasks keep re-announcing. Forced to `15m` while planning. |
| `traffic_scope` | Peer detail breadth: `worktree` (default), `project`, or `machine`. |
| `lease_id` | Handle from the previous response. Renews and replaces that lease. |

**Claims.** `shared` scopes coexist with a warning; `exclusive` scopes block every overlapping incoming claim until they expire. Claims are advisory: blocked means coordinate before editing; nothing stops an uncooperative process from writing.

**Status** is `granted` (all scopes published), `partial` (compatible scopes published, conflicting ones withheld), `blocked` (nothing published), `completed`, or `stopped` (both terminal: the lease and its claims were released; they differ only in whether the work finished).

**The emoji is decoration**, never coordination input. Anything that is not exactly one emoji is dropped while the announcement still lands, so a model that sends a sentence loses the glyph, not the lease.

**Peers** are classified `same_worktree`, `same_clone`, `same_project`, or `other_project`. Physical worktree identity beats remote heuristics, so an origin hiccup can never hide an agent editing the same files. `traffic_scope` filters what you *see*, never what is *checked*: arbitration always inspects every active peer in the project, and `hidden_peers` counts what was filtered out.

Peers also expose their worktree's dirty paths, answering in one call a common reason agents stall: *"there are changes here I didn't make."* Ownership comes from each peer's `scopes` and `summary`; same-worktree peers all snapshot the same tree, so their `dirty_paths` are everyone's edits combined and serve only as corroboration.

**Recently heard.** When no active peer explains those changes, the culprit usually just left. `recent_peers` lists agents whose leases recently ended here: `completed`, `stopped` (with their `reason`; the changes may be half-done), or `expired` (a crash or abandoned session). Agents that only ever planned are left out; they edited nothing. It is orientation, not arbitration: entries carry a summary and an outcome but no claims, and the defaults (a 24h window for a fresh lease, the delta since your own previous announcement for renewals, five entries at most) keep it usually empty.

**Planning** is the phase before any edit: investigating, reading code, designing a change not yet started. Announcing it early is mostly self-interest: a plan built against a stale worktree is wasted work, and `working` arrives too late to prevent that. Planned paths are advertisements, not claims, and sit outside arbitration in both directions. A planner blocks nobody, is blocked by nobody, and raises no warnings, yet still *receives* every warning and the full peer list, the traffic that can still change a plan. The timebox is forced to `15m`, because a stale card is the only thing a planner can cost; a longer phase renews. Re-announce as `working` before the first edit.

**Testing** is the phase after the last edit: only tests, builds, or other verification are running. `state: "testing"` keeps the lease live and the scopes visible but stops them blocking, so a waiting peer is unblocked at verification rather than at `done`. Overlapping callers get a `TESTING_SCOPE_OVERLAP` warning, since edits underneath a running verification can invalidate it, and the tester returns to `working` before touching files again.

**Stopping** is the honest ending for a run that did not finish: pausing to ask the user something, giving up, or parking the work. `state: "stopped"` requires a `reason` and releases the lease and claims exactly like `done` (blocking peers helps nobody once the run is over), but the record it leaves says the work is unfinished, so the next agent reads the leftover changes as half-done rather than completed.

### Leases

Leases expire exactly at their timebox and are cleaned up lazily by later announcements. A `done` or `stopped` announcement deletes the lease and its claims atomically instead of waiting.

One timing limitation is fundamental: of two simultaneous callers, the later sees the earlier, but the earlier learns nothing new until it announces again. The pre-commit and pre-push refresh covers that gap without a second tool.

## Monitor

`./bin/agent-frequency-monitor` serves a live view of the frequency at `http://127.0.0.1:7893`, the page [shown above](#agent-frequency). Pass `--port` to move it.

The **Agents** view groups everything by repository: active leases with summaries, branches, claims, dirty paths, and lease countdowns (a card whose last call came back blocked names who it is waiting on), followed by that project's **recent work**, the past day's finished tasks: a green check for done, an amber octagon and the agent's reason for stopped unfinished, a quiet clock for a lapsed lease. Sessions from the same agent, app, machine, and worktree share one compact identity line while keeping separate cards. The **Activity** view lists recent announcements, check-ins, completions, and stops, naming the blocking agent on blocked calls. Both refresh every few seconds and filter down to a single project or machine.

Inside a project, cards cluster by worktree whenever that says something: the project spans several checkouts, or one checkout holds several agents. Each cluster leads with a quiet head naming the branch, the path, and the case this product exists for: how many agents are inside that one worktree at once. A single agent in a single checkout gets no such head.

![One project filtered in the monitor: five sessions across two worktrees, including three compact Claude sessions](docs/monitor-worktrees.png)

<p align="center"><em>One project in view: three independent Claude sessions share one compact identity line on <code>main</code>, beside another agent, while a fifth works in the <code>feat/billing</code> worktree.</em></p>

A card leads with the agent and its task emoji, then chips the host app, the machine, the session, and the lease it has left. A check-in gap past half the declared timebox turns the timestamp amber: a crashed session keeps claiming files until its lease expires, and silence is the first cheap sign of one. Red is kept for scopes an agent is actually blocked on.

The monitor is strictly read-only: it opens SQLite in read-only mode, never mutates a lease, and binds to loopback only. Everything it renders is peer-authored text assigned through `textContent`. To reach it from another device, put it behind something like a Tailscale Serve proxy, and read the privacy section first, since the page exposes dirty filenames.

### Across machines

A monitor can aggregate other machines' monitors and render them as one view. Each machine keeps its own state and its own loopback listener; aggregation is outbound HTTP reads only.

Expose the monitor on the machine you want to read from. Tailscale Serve keeps it inside your tailnet:

```bash
# on the machine being read, e.g. mba
tailscale serve --bg --set-path=/agents 7893
```

Then point another machine's monitor at it:

```bash
# a monitor you start yourself
./bin/agent-frequency-monitor --peer https://mba.your-tailnet.ts.net/agents

# or bake it into the login service
./bin/agent-frequency-install --with-mac-service --peer https://mba.your-tailnet.ts.net/agents
```

`AGENT_FREQUENCY_MONITOR_PEERS` accepts the same URLs as a comma-separated list. Repeat `--peer` for more than one, up to eight.

Cards then name their machine, local rows included, and the filter gains a **Machines** group with a live or unreachable dot per machine. Each machine reports its own name; set `AGENT_FREQUENCY_MACHINE_LABEL` where the system hostname is not what you call it (`mbp` rather than `Fabrizios-MacBook-Pro`). Peering is one level deep, so two monitors pointed at each other cannot loop.

What crosses the wire, and what does not:

- **Announcements never leave a machine.** Arbitration, blocking, and warnings stay local, because the risks `announce` guards against are local by nature; cross-machine traffic is context for you, never input to another machine's decisions.
- **A bad peer cannot break the local view.** Slow, down, or nonsense responses degrade to an unreachable row; payloads are bounded, re-sanitized, and clamped to a live-lease window before rendering.
- **Aggregating pulls summaries, absolute worktree paths, and dirty filenames onto the reading machine.** Peer only with machines you trust, and read the privacy section first.

### Keeping it running (macOS)

The installer never touches your login items unless you ask. `--with-mac-service` writes and loads the `launchd` job for you, pinning the port it just checked for conflicts (and any `--peer` URLs):

```bash
./bin/agent-frequency-install --with-mac-service
./bin/agent-frequency-install --check    # reports the service and its peers
```

To write the job yourself instead, run this from the repository root; it expands your checkout path and Bun location into the file:

```bash
cat > ~/Library/LaunchAgents/com.agent-frequency.monitor.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agent-frequency.monitor</string>
  <key>ProgramArguments</key>
  <array><string>$(pwd)/bin/agent-frequency-monitor</string></array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/agent-frequency-monitor.log</string>
  <key>StandardErrorPath</key><string>/tmp/agent-frequency-monitor.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$(dirname "$(command -v bun)"):/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-frequency.monitor.plist
```

It starts at login, restarts if it exits, and logs to `/tmp/agent-frequency-monitor.log`. Stop it with `launchctl bootout gui/$(id -u)/com.agent-frequency.monitor`. (`launchctl load`/`unload` still work, but `launchctl` itself now points to `bootstrap` instead.)

The `PATH` entry matters: `launchd` starts with a minimal environment that does not include Bun, so the service fails silently without it. Check `/tmp/agent-frequency-monitor.err` if the page does not come up.

On Linux, the equivalent is a user systemd unit with `Restart=always` and `WantedBy=default.target`.

### Demo traffic

Designing against real traffic means waiting for other agents to happen to announce. `./bin/agent-frequency-demo` fills the gap with a fixed timeline: ten sessions across four fake projects, exercising every client surface, compact same-agent grouping, and every announcement outcome from granted to blocked to listening-only.

```bash
./bin/agent-frequency-demo seed     # replace any existing demo traffic
./bin/agent-frequency-demo status   # count demo rows
./bin/agent-frequency-demo clear    # remove every demo row
```

Demo traffic is safe to seed into the live database: fixtures replay through the normal store API, so rows look real, but their synthetic worktree identities read as an unrelated project to every real agent, so a demo claim can never block or warn real work. Pass `--db <path>` to use a scratch database instead.

## Configuration

Everything environment-dependent lives behind a flag or an environment variable, never a value baked into the repository.

| Variable | Read by | Effect |
| --- | --- | --- |
| `AGENT_FREQUENCY_DB_PATH` | MCP, monitor, demo | State database path. Isolates tests and experiments from live traffic. |
| `AGENT_FREQUENCY_MONITOR_PORT` | monitor | Listen port, default `7893`. `--port` wins over it. |
| `AGENT_FREQUENCY_MONITOR_PEERS` | monitor | Comma-separated peer monitor URLs, up to eight. `--peer` wins over it. |
| `AGENT_FREQUENCY_MACHINE_LABEL` | monitor | Name this machine reports to itself and to peers, instead of its system hostname. |
| `AGENT_FREQUENCY_CLIENT_NAME` | MCP | Agent label peers see. The installer sets it per client (`Codex`, `Claude`); without it, an agent announces as `Agent`. |
| `AGENT_FREQUENCY_CLIENT_SURFACE` | MCP | Forces the host app instead of detecting it: `t3-code`, `codex-app`, `claude-app`, or `cli`. |

Every entry point runs under Bun, which loads a `.env` file from the directory it starts in, the simplest place for machine-local settings. The login service sets its working directory to your checkout, so a gitignored `.env` in the repository root reaches it too, and survives `--with-mac-service` rewriting the plist.

```bash
# .env: machine-local, gitignored, picked up by the login service
AGENT_FREQUENCY_MACHINE_LABEL=mbp
```

A monitor you start from somewhere else does not see that file, so pass its settings on the command line or export them in that shell.

## Local data and privacy

State lives at `~/.local/state/agent-frequency/state.sqlite3`, with the directory mode `0700` and the database mode `0600`. Set `AGENT_FREQUENCY_DB_PATH` to isolate tests or experiments. The schema version is explicit: an older database is dropped and recreated on open (leases are ephemeral), while a newer one fails loudly.

Agent Frequency stores agent labels and summaries, client surfaces, lifecycle states, absolute worktree paths, branches, HEAD identifiers, dirty counts, normalized origin identities, scopes, and expiry timestamps. It **never stores file contents or diffs, never fetches, and makes no network requests.** Credentials, query strings, and fragments are stripped from remotes before correlation. Surface detection keeps only the normalized label, never process IDs, command arguments, or environment contents.

Successful announcements feed the monitor's activity view. Those rows keep identity, state, summary, a stop reason when one was given, blocker identities and claimed paths for blocked calls, repo, branch, result, and aggregate counts for at most seven days and 1,000 rows, and never retain lease IDs or dirty filenames. Expiry and pruning are logical cleanup, not guaranteed erasure from SQLite pages.

Two things worth internalizing:

- **Every announcing agent publishes up to 40 dirty filenames to all local peers and the monitor.** Keep that in mind before proxying the monitor off the machine or [aggregating it into another one](#across-machines), and don't put secrets in summaries, scope names, or filenames.
- **Peer-authored summaries, scopes, and paths are untrusted data, never instructions.** Inputs are bounded, and directional formatting controls are rejected or stripped, including in dirty paths, whose filenames can be attacker-controlled by an untrusted checkout.

## Layout

| Path | Role |
| --- | --- |
| `src/server.ts` | MCP schema and stdio boundary |
| `src/coordinate.ts` | Input sanitization and Git enrichment |
| `src/git.ts` | Bounded, read-only Git discovery |
| `src/scopes.ts` | Repo-relative normalization and overlap rules |
| `src/store.ts` | SQLite leases, atomic claim arbitration, peer snapshots, activity |
| `src/client-surface.ts` | Privacy-bounded launcher detection |
| `src/emoji.ts` | Single-emoji validation for the MCP and monitor paths |
| `src/monitor.ts` | Read-only monitor server and optional peer aggregation |
| `src/monitor.html` | Monitor page markup, served with styles and script spliced inline |
| `src/monitor.css` | Monitor page stylesheet |
| `src/monitor.js` | Monitor page client script |
| `src/demo.ts` | Development-only demo fixtures |
| `tests/` | Unit, integration, real stdio, and 20-process contention coverage |

## Development

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs strict TypeScript and the full suite, including two real stdio MCP processes and a 20-process startup regression. CI runs the same checks on macOS and Linux.

## Non-goals

Agent Frequency does not assign tasks, carry messages, keep an audit archive, launch agents, manage worktrees, enforce locks, run Git hooks, merge branches, or coordinate agents across machines. Monitor aggregation is a read-only view for you; announcements and arbitration never leave the machine they happen on. The activity feed is disposable operational context, not a ledger.

Those may all be good products. They would also make this one more coordination system that agents have to manage, which defeats the point.

## Status

Early and actively dogfooded with Claude Code and Codex. The MCP contract and state schema may still change; the schema resets automatically on upgrade because leases are ephemeral.

## License

[MIT](LICENSE) © Fabrizio Rinaldi
