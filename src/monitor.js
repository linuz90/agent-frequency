// Client script for the monitor page, spliced inline into monitor.html by
// pageAsset() in monitor.ts so the page ships as one self-contained response.
//
// Every value below (summaries, labels, branches, paths, claim paths) is
// peer-authored and untrusted. The page therefore builds DOM nodes and
// assigns textContent only; nothing here ever assembles markup from data.
(function () {
  "use strict";

  var UI_VERSION = "__AGENT_FREQUENCY_UI_VERSION__";
  var REFRESH_MS = 3000;
  var TICK_MS = 1000;
  // Recent work is orientation, not history: only tasks from the last
  // day, and only a handful per project. The Activity tab keeps the
  // full seven-day feed.
  var RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
  var MAX_PROJECT_RECENT_TASKS = 5;

  var main = document.getElementById("main");
  var footer = document.getElementById("footer");
  var countEl = document.getElementById("count");
  var overviewCopyEl = document.getElementById("overview-copy");
  var liveEl = document.getElementById("live");
  var liveTextEl = document.getElementById("live-text");
  var agentsTabEl = document.getElementById("agents-tab");
  var activityTabEl = document.getElementById("activity-tab");
  var projectFilterEl = document.getElementById("project-filter");
  var projectFilterSelectEl = document.getElementById("project-filter-select");
  var machinesEl = document.getElementById("machines");

  var timeNodes = [];
  var clockOffsetMs = 0;
  var lastSuccessMs = null;
  var failing = false;
  var lastSignature = null;
  var latestState = null;
  var activeView = window.location.hash === "#activity" ? "activity" : "agents";
  var selectedRepo = new URLSearchParams(window.location.search).get("repo") || "";
  var selectedMachine = new URLSearchParams(window.location.search).get("machine") || "";
  var repoOptionsSignature = null;
  // Expanded path lists survive re-renders; a three-second refresh must
  // not keep closing a list the user just opened.
  var openDetails = new Set();
  // Recent work collapses by default so a project's finished tasks can
  // never push another project's live agents below the fold — the whole
  // point of the page is what is running now. A reader who opens one is
  // remembered per project for the life of the tab, which is the span
  // over which that choice stays meaningful.
  var RECENT_STORAGE_KEY = "agent-frequency:recent-open";
  var MAX_REMEMBERED_RECENTS = 50;
  var recentOpen = loadRecentOpen();

  // Repository names are peer-authored, so the stored shape is an entry
  // array read into a Map: names such as "__proto__" stay ordinary keys.
  function loadRecentOpen() {
    try {
      var raw = window.sessionStorage.getItem(RECENT_STORAGE_KEY);
      if (!raw) return new Map();
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Map();
      return new Map(
        parsed.filter(function (entry) {
          return (
            Array.isArray(entry) &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "boolean"
          );
        })
      );
    } catch (error) {
      // Disabled or full storage is not worth a broken page; the
      // defaults simply stop being remembered.
      return new Map();
    }
  }

  function rememberRecentOpen(name, open) {
    recentOpen.delete(name);
    recentOpen.set(name, open);
    var entries = Array.from(recentOpen.entries());
    if (entries.length > MAX_REMEMBERED_RECENTS) {
      entries = entries.slice(entries.length - MAX_REMEMBERED_RECENTS);
      recentOpen = new Map(entries);
    }
    try {
      window.sessionStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(entries));
    } catch (error) {
      /* see loadRecentOpen */
    }
  }

  // === DOM helpers ===

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * A summary line, optionally led by the agent's task emoji. The emoji is
   * decorative next to the text it accompanies, so it stays out of the
   * accessibility tree. Server-side validation guarantees a single emoji,
   * and textContent keeps any surprise inert.
   */
  function summaryLine(className, emoji, text) {
    var line = el("p", className);
    if (emoji) {
      var glyph = el("span", "task-emoji", emoji);
      glyph.setAttribute("aria-hidden", "true");
      line.appendChild(glyph);
    }
    line.appendChild(el("span", "summary-text", text));
    return line;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(className, viewBox) {
    var node = document.createElementNS(SVG_NS, "svg");
    node.setAttribute("class", className);
    node.setAttribute("viewBox", viewBox || "0 0 24 24");
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function svgShape(parent, tag, attributes) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attributes).forEach(function (name) {
      node.setAttribute(name, attributes[name]);
    });
    parent.appendChild(node);
  }

  // === Icons ===

  // Provider labels only select one of these fixed trusted marks. Peer
  // text never enters SVG markup, preserving the page's injection boundary.
  function providerIcon(agentLabel, agentId) {
    var identity = ((agentLabel || "") + " " + (agentId || "")).toLowerCase();
    var icon = svgEl("provider-icon");

    if (identity.indexOf("codex") !== -1 || identity.indexOf("openai") !== -1) {
      icon.setAttribute("fill", "currentColor");
      svgShape(icon, "path", {
        d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
      });
      return icon;
    }

    if (identity.indexOf("claude") !== -1 || identity.indexOf("anthropic") !== -1) {
      icon.setAttribute("fill", "currentColor");
      svgShape(icon, "path", {
        d: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
      });
      return icon;
    }

    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    svgShape(icon, "path", { d: "M12 8V4H8" });
    svgShape(icon, "rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" });
    svgShape(icon, "path", { d: "M2 14h2" });
    svgShape(icon, "path", { d: "M20 14h2" });
    svgShape(icon, "path", { d: "M15 13v2" });
    svgShape(icon, "path", { d: "M9 13v2" });
    return icon;
  }

  function forkIcon() {
    var icon = svgEl("", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    svgShape(icon, "circle", { cx: "12", cy: "18", r: "3" });
    svgShape(icon, "circle", { cx: "6", cy: "6", r: "3" });
    svgShape(icon, "circle", { cx: "18", cy: "6", r: "3" });
    svgShape(icon, "path", { d: "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" });
    svgShape(icon, "path", { d: "M12 12v3" });
    return icon;
  }

  function completionIcon(className) {
    var icon = svgEl(className || "completion-icon");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    svgShape(icon, "path", { d: "m5 12 4 4L19 6" });
    return icon;
  }

  // The counterpart to the completion check: work that simply stopped
  // calling and let its lease run out, rather than releasing it.
  function quietIcon() {
    var icon = svgEl("task-icon");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    svgShape(icon, "circle", { cx: "12", cy: "12", r: "8" });
    svgShape(icon, "path", { d: "M12 8v4l2.5 2.5" });
    return icon;
  }

  // A deliberate stop without a finish: an octagon, between the completion
  // check and the quiet clock — the agent said it was ending, and said why.
  function stopIcon(className) {
    var icon = svgEl(className || "stop-icon");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linejoin", "round");
    svgShape(icon, "polygon", {
      points: "7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86",
    });
    return icon;
  }

  // === Clocks and relative time ===

  function now() {
    return Date.now() + clockOffsetMs;
  }

  function formatDuration(ms) {
    var seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return seconds + "s";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m";
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return rest === 0 ? hours + "h" : hours + "h " + rest + "m";
  }

  function formatExpiry(expiresAtMs) {
    var remaining = expiresAtMs - now();
    return remaining <= 0 ? "expired" : formatDuration(remaining) + " left";
  }

  /**
   * The countdown chip stays short; the title says when the lease actually
   * ends and how long a window the agent asked for.
   */
  function expiryTitle(lease) {
    var when = new Date(lease.expires_at_ms).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    var timebox = lease.timebox_seconds
      ? " · " + formatDuration(lease.timebox_seconds * 1000) + " timebox"
      : "";
    return "Lease expires at " + when + timebox;
  }

  // A lease keeps ticking after the process holding it dies, so silence is
  // the first sign of a crashed agent. Half the declared timebox is the
  // threshold, floored so a short lease is not called stale for a pause
  // between ordinary calls.
  var MIN_STALE_MS = 15 * 60 * 1000;

  function staleAfterMs(lease) {
    return Math.max(MIN_STALE_MS, ((lease.timebox_seconds || 0) * 1000) / 2);
  }

  function formatAge(atMs) {
    var elapsed = now() - atMs;
    if (elapsed < 10000) return "updated just now";
    return "updated " + formatDuration(elapsed) + " ago";
  }

  function formatEventAge(atMs) {
    var elapsed = now() - atMs;
    if (elapsed < 10000) return "just now";
    return formatDuration(elapsed) + " ago";
  }

  function trackTime(node, kind, atMs, staleAfter) {
    var entry = { node: node, kind: kind, atMs: atMs, staleAfter: staleAfter || null };
    timeNodes.push(entry);
    applyTime(entry);
  }

  function applyTime(entry) {
    entry.node.textContent =
      entry.kind === "expiry"
        ? formatExpiry(entry.atMs)
        : entry.kind === "event"
          ? formatEventAge(entry.atMs)
          : formatAge(entry.atMs);
    // Staleness has to move with the clock rather than with the data: an
    // idle card never re-renders, and silence is exactly what it would
    // then be failing to report.
    if (entry.staleAfter) {
      var stale = now() - entry.atMs > entry.staleAfter;
      entry.node.classList.toggle("stale", stale);
      entry.node.title = stale
        ? "No check-in for over half this lease's timebox; the agent may have stopped."
        : "";
    }
  }

  // === Agent identity chips ===

  // The worktree's own folder name — the part managed-worktree tools vary
  // per task (`.t3/worktrees/islands/t3code-aeb1ed1b`).
  function pathTail(path) {
    if (!path) return "";
    var parts = path.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : path;
  }

  function abbreviate(path, homeDir) {
    if (!homeDir || !path) return path || "";
    if (path === homeDir) return "~";
    if (path.indexOf(homeDir + "/") === 0) return "~" + path.slice(homeDir.length);
    return path;
  }

  function shortAgentId(agentId, agentLabel) {
    var id = agentId || "Agent";
    var prefix = (agentLabel || "") + " ";
    var compact = prefix.trim() && id.indexOf(prefix) === 0 ? id.slice(prefix.length) : id;
    return compact.length > 10
      ? compact.slice(0, 4) + "…" + compact.slice(compact.length - 4)
      : compact;
  }

  function surfaceLabel(surface) {
    if (surface === "t3-code") return "T3 Code";
    if (surface === "codex-app") return "Codex app";
    if (surface === "claude-app") return "Claude app";
    if (surface === "cli") return "CLI";
    return null;
  }

  /**
   * Where a session runs: its host app and, once more than one machine is
   * in view, the machine. Both are peer-authored strings rendered through
   * textContent, so the chip carries no markup of its own.
   */
  function originChip(clientSurface, machine) {
    var app = surfaceLabel(clientSurface);
    if (!app && !machine) return null;
    var chip = el("span", "chip origin-chip");
    if (app) chip.appendChild(el("span", "origin-app", app));
    if (app && machine) chip.appendChild(el("span", "origin-sep", "·"));
    if (machine) {
      var host = el("span", "origin-machine", machine);
      host.title = machine;
      chip.appendChild(host);
    }
    return chip;
  }

  /**
   * The session id, shortened to its distinguishing ends. The chip drops
   * the word "session" — its shape and monospace already say identifier —
   * and the title carries the id in full.
   */
  function sessionChip(agentId, agentLabel) {
    var chip = el("span", "chip session-chip mono", shortAgentId(agentId, agentLabel));
    chip.title = "session " + (agentId || agentLabel || "");
    return chip;
  }

  function identityKey(agentLabel, agentId, clientSurface, machine) {
    return JSON.stringify([
      (agentLabel || agentId || "Agent").toLowerCase(),
      clientSurface || "unknown",
      machine || "",
    ]);
  }

  function identityDescription(agentLabel, agentId, clientSurface, machine) {
    var parts = [agentLabel || agentId || "Agent"];
    var app = surfaceLabel(clientSurface);
    if (app) parts.push(app);
    if (machine) parts.push(machine);
    if (agentId) parts.push("session " + agentId);
    return parts.join(", ");
  }

  // Identity is the agent and where it runs. A standalone card also names its
  // session; a shared identity head leaves that detail to the compact cards it
  // introduces so the same Codex / T3 Code line is not repeated down the page.
  function renderAgentIdentity(agentLabel, agentId, clientSurface, sameWorktree, machine) {
    var label = agentLabel || agentId || "Agent";
    var name = el("div", "agent-name");
    name.appendChild(el("span", "agent-label", label));
    var chip = originChip(clientSurface, machine);
    if (chip) name.appendChild(chip);
    if (agentId) name.appendChild(sessionChip(agentId, label));
    if (sameWorktree) {
      var kind = el("span", "chip session-kind", "same worktree");
      kind.prepend(forkIcon());
      name.appendChild(kind);
    }
    return name;
  }

  // === Merging local and peer traffic ===

  function peerMachineLabel(peer) {
    if (peer.hostname) return peer.hostname;
    // The configured peer URL is trusted local configuration; its first
    // host label is a readable fallback when the peer reports no name.
    try {
      var host = new URL(peer.url).hostname;
      return host.split(".")[0] || peer.url;
    } catch (error) {
      return peer.url;
    }
  }

  /**
   * The label for traffic from this machine, or null when no peers are
   * configured. A single-machine monitor would print the same name on
   * every row, so the machine only becomes a visible dimension once it
   * distinguishes something — the same rule the project filter uses.
   */
  function localMachineName(state) {
    return (state.peers || []).length > 0 ? localMachineLabel(state) : null;
  }

  // Peer machines' traffic renders through the same code paths as local
  // traffic. Each entry carries its machine label and that machine's home
  // directory so absolute worktree paths abbreviate against the right
  // home.
  function leaseEntries(state) {
    var entries = [];
    var local = localMachineName(state);
    state.leases.forEach(function (lease) {
      entries.push({ lease: lease, machine: local, homeDir: state.home_dir });
    });
    (state.peers || []).forEach(function (peer) {
      if (!peer.snapshot) return;
      var machine = peerMachineLabel(peer);
      peer.snapshot.leases.forEach(function (lease) {
        entries.push({ lease: lease, machine: machine, homeDir: peer.snapshot.home_dir });
      });
    });
    return entries;
  }

  function eventEntries(state) {
    var local = localMachineName(state);
    var entries = (state.events || []).map(function (event) {
      return { event: event, machine: local };
    });
    (state.peers || []).forEach(function (peer) {
      if (!peer.snapshot) return;
      var machine = peerMachineLabel(peer);
      (peer.snapshot.events || []).forEach(function (event) {
        entries.push({ event: event, machine: machine });
      });
    });
    // Peer timestamps arrive rebased onto this machine's clock, so one
    // merged chronological feed is meaningful.
    entries.sort(function (left, right) {
      return right.event.created_at_ms - left.event.created_at_ms;
    });
    return entries;
  }

  function totalEventCount(state) {
    var total = state.event_count || 0;
    (state.peers || []).forEach(function (peer) {
      if (peer.snapshot) total += peer.snapshot.event_count || 0;
    });
    return total;
  }

  // === Blockers ===

  // Agent ids are "<label> <hex suffix>"; the last four suffix characters
  // are enough to tell two same-label sessions apart in a short mention.
  function blockerName(agentId) {
    var id = agentId || "agent";
    var space = id.lastIndexOf(" ");
    if (space <= 0) return id.length > 12 ? id.slice(0, 12) + "…" : id;
    var suffix = id.slice(space + 1);
    return id.slice(0, space) + " " + (suffix.length > 4 ? suffix.slice(suffix.length - 4) : suffix);
  }

  // "waiting on Claude 8754" (+ optionally "and N more"), with the full
  // blocker ids and claimed paths in the title. Blocker identity is recorded
  // with the event by the announce call itself, so this is server-observed
  // rather than self-reported.
  function waitingText(blockers) {
    var names = [];
    blockers.forEach(function (blocker) {
      var name = blockerName(blocker.agent_id);
      if (names.indexOf(name) === -1) names.push(name);
    });
    var text = "waiting on " + names.slice(0, 2).join(", ");
    if (names.length > 2) text += " and " + (names.length - 2) + " more";
    return text;
  }

  function waitingTitle(blockers) {
    return blockers
      .map(function (blocker) {
        return blocker.agent_id + (blocker.path ? " holds " + blocker.path : "");
      })
      .join("\n");
  }

  // The freshest call each session made in each worktree, so a live card can
  // show whether its agent's last word was "blocked". Self-clearing: the next
  // granted announce becomes the latest event and the note disappears.
  function latestEventsByTask(state) {
    var latest = new Map();
    eventEntries(state).forEach(function (entry) {
      var key = taskKey(entry.machine, entry.event.agent_id, entry.event.worktree_root);
      if (!latest.has(key)) latest.set(key, entry.event);
    });
    return latest;
  }

  // === Recent tasks ===

  // The activity feed is a log of individual calls. The Agents view wants
  // finished work instead, so calls are rolled up into tasks: one run of
  // calls by one session in one worktree, closed by its "done" call. A
  // session that announces again after finishing starts a new task.
  function taskKey(machine, agentId, worktreeRoot) {
    return (machine || "") + "\u0000" + agentId + "\u0000" + worktreeRoot;
  }

  function recentTasks(state) {
    var entries = eventEntries(state);
    var active = new Set();
    leaseEntries(state).forEach(function (entry) {
      active.add(taskKey(entry.machine, entry.lease.agent_id, entry.lease.worktree_root));
    });

    var open = new Map();
    var tasks = [];
    // eventEntries is newest first; replaying oldest first lets each
    // "done" call close exactly the run of calls that led up to it.
    for (var index = entries.length - 1; index >= 0; index -= 1) {
      var entry = entries[index];
      var event = entry.event;
      var key = taskKey(entry.machine, event.agent_id, event.worktree_root);
      var task = open.get(key);
      if (task) {
        // Later calls in a task carry the freshest wording and branch.
        task.summary = event.summary;
        task.emoji = event.emoji;
        task.repo_name = event.repo_name;
        task.branch = event.branch;
        task.ended_at_ms = event.created_at_ms;
      } else {
        task = {
          machine: entry.machine,
          agent_id: event.agent_id,
          agent_label: event.agent_label,
          client_surface: event.client_surface,
          summary: event.summary,
          emoji: event.emoji,
          repo_name: event.repo_name,
          worktree_root: event.worktree_root,
          branch: event.branch,
          started_at_ms: event.created_at_ms,
          ended_at_ms: event.created_at_ms,
          // "released" when closed by done, "stopped" when the agent ended
          // the run unfinished and said why, "expired" when it went quiet.
          outcome: "expired",
          reason: null,
          // Whether this session ever announced anything but planning here.
          edited: false,
        };
      }
      if (event.agent_state !== "planning") task.edited = true;
      if (event.agent_state === "done" || event.agent_state === "stopped") {
        task.outcome = event.agent_state === "stopped" ? "stopped" : "released";
        task.reason = event.reason || null;
        tasks.push(task);
        open.delete(key);
      } else {
        open.set(key, task);
      }
    }

    open.forEach(function (task, key) {
      // A session that never announced "done" is only past work once its
      // lease is gone; while it is live its own card already shows it.
      if (!active.has(key)) tasks.push(task);
    });

    tasks.sort(function (left, right) {
      return right.ended_at_ms - left.ended_at_ms;
    });
    // The window is checked against the server clock at render time; a
    // task ages out on the next data change rather than the second it
    // crosses the boundary, which is close enough for orientation.
    var cutoff = now() - RECENT_WINDOW_MS;
    return tasks.filter(function (task) {
      if (task.ended_at_ms < cutoff) return false;
      // A session that only ever planned and then let its lease lapse
      // changed nothing and left nothing behind, so it is not recent work.
      // One that planned and said done or stopped reported an outcome, and
      // that is worth keeping whether or not it wrote a file.
      return task.edited || task.outcome !== "expired";
    });
  }

  function visibleTasks(state) {
    var tasks = recentTasks(state);
    if (!filterLabel()) return tasks;
    return tasks.filter(function (task) {
      return matchesFilter(state, repoName(task), task.machine);
    });
  }

  // Several Codex or Claude sessions often finish together. Their session ids
  // still distinguish the rows, but agent, app, and machine are one shared
  // identity and only need saying once.
  function groupTasksByIdentity(tasks) {
    var groups = [];
    tasks.forEach(function (task) {
      var key = identityKey(
        task.agent_label,
        task.agent_id,
        task.client_surface,
        task.machine
      );
      var group = groups[groups.length - 1];
      if (!group || group.key !== key) {
        group = { key: key, tasks: [] };
        groups.push(group);
      }
      group.tasks.push(task);
    });
    // Only adjacent tasks collapse; an intervening identity remains meaningful
    // chronology rather than being reordered for presentation.
    return groups.map(function (group) {
      return group.tasks;
    });
  }

  // Finished work lives with its project: tasks group under the same
  // repository sections as live agents, capped so a busy project stays
  // a summary. Map iteration order is first appearance, and tasks
  // arrive newest first, so leftover repos without live agents already
  // read most-recent first.
  function groupTasksByRepo(tasks) {
    var groups = new Map();
    tasks.forEach(function (task) {
      var key = repoName(task);
      if (!groups.has(key)) groups.set(key, []);
      var list = groups.get(key);
      if (list.length < MAX_PROJECT_RECENT_TASKS) list.push(task);
    });
    return groups;
  }

  /**
   * A project's finished tasks, behind a disclosure. `defaultOpen` is for
   * a section that holds nothing else — collapsing it would leave a bare
   * heading — and a remembered choice for this project wins over it.
   */
  function renderRecentTasks(section, tasks, defaultOpen) {
    var name = repoName(tasks[0]);
    var details = el("details", "recent-details");
    details.agentFrequencyKey = "recent\u0000" + name;
    var remembered = recentOpen.get(name);
    details.open = remembered === undefined ? defaultOpen === true : remembered;
    details.addEventListener("toggle", function () {
      rememberRecentOpen(name, details.open);
    });
    details.appendChild(el("summary", "recent-label", "Recent"));
    section.appendChild(details);

    // Branch usually identifies the checkout a task ran in, but not when a
    // project has several worktrees on it — then the folder name is what
    // separates them, so it only appears when it distinguishes something.
    var roots = new Set(
      tasks.map(function (task) {
        return task.worktree_root || "";
      })
    );
    var showWorktree = roots.size > 1;

    groupTasksByIdentity(tasks).forEach(function (identityTasks) {
      var newest = identityTasks[0];
      var label = newest.agent_label || newest.agent_id;
      var group = el("section", "task-group");
      var sessions = new Set(
        identityTasks.map(function (task) {
          return task.agent_id;
        })
      );

      var groupHead = el("div", "task-group-head");
      var agent = el("span", "task-group-agent");
      agent.appendChild(providerIcon(label, newest.agent_id));
      agent.appendChild(el("span", null, label));
      groupHead.appendChild(agent);
      var origin = originChip(newest.client_surface, newest.machine);
      if (origin) groupHead.appendChild(origin);
      if (sessions.size === 1) {
        groupHead.appendChild(sessionChip(newest.agent_id, label));
      } else {
        groupHead.appendChild(el("span", "task-group-count", sessions.size + " sessions"));
      }
      // The repository is already the section this group sits in, so the
      // head carries only context shared by every row beneath it.
      function taskWhere(task) {
        var where = task.branch || "";
        if (showWorktree && task.worktree_root) {
          where = where
            ? where + " · " + pathTail(task.worktree_root)
            : pathTail(task.worktree_root);
        }
        return where;
      }
      var locations = new Set(identityTasks.map(taskWhere));
      var sharedWhere = locations.size === 1 ? taskWhere(newest) : "";
      if (sharedWhere) {
        var whereEl = el("span", "task-group-where mono", sharedWhere);
        if (newest.worktree_root) whereEl.title = newest.worktree_root;
        groupHead.appendChild(whereEl);
      }
      group.appendChild(groupHead);

      identityTasks.forEach(function (task) {
        var row = el("div", "task-row");
        row.setAttribute("data-outcome", task.outcome);
        row.appendChild(
          task.outcome === "released"
            ? completionIcon("task-icon")
            : task.outcome === "stopped"
              ? stopIcon("task-icon")
              : quietIcon()
        );
        row.appendChild(summaryLine("task-summary", task.emoji, task.summary));
        var timestamp = el("time", "task-time");
        trackTime(timestamp, "event", task.ended_at_ms);
        row.appendChild(timestamp);

        // Every call a task made is one tab away in Activity, so a row carries
        // only what sets it apart: how it ended, its session when the shared
        // identity has several, how long it ran, and any differing location.
        var meta = el("div", "task-meta");
        if (task.outcome === "expired") meta.appendChild(el("span", null, "lease ran out"));
        if (task.outcome === "stopped") {
          meta.appendChild(
            el("span", "task-reason", "stopped: " + (task.reason || "unfinished"))
          );
        }
        if (sessions.size > 1) {
          meta.appendChild(sessionChip(task.agent_id, task.agent_label || task.agent_id));
        }
        // Only the calls still inside the seven-day window are visible, so
        // a task that started before it reads as shorter than it ran.
        var span = task.ended_at_ms - task.started_at_ms;
        if (span >= 60000) meta.appendChild(el("span", null, "ran " + formatDuration(span)));
        var where = taskWhere(task);
        if (!sharedWhere && where) {
          var rowWhere = el("span", "mono", where);
          if (task.worktree_root) rowWhere.title = task.worktree_root;
          meta.appendChild(rowWhere);
        }
        if (meta.childNodes.length > 0) row.appendChild(meta);

        group.appendChild(row);
      });

      details.appendChild(group);
    });
  }

  // === Grouping and filtering ===

  function groupByRepo(entries) {
    var order = [];
    // Repository names are peer-controlled. A Map keeps names such as
    // "__proto__" from resolving inherited Object properties.
    var groups = new Map();
    entries.forEach(function (entry) {
      var key = repoName(entry.lease);
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key).push(entry);
    });
    return order.map(function (key) {
      return { name: key, entries: groups.get(key) };
    });
  }

  function repoName(item) {
    return item.repo_name || "unknown repo";
  }

  /**
   * Worktrees are where agents actually collide: two sessions in one
   * checkout edit the same files, while two worktrees of the same project
   * are independent. Grouping by (machine, worktree_root) mirrors the
   * arbitration boundary the server already uses — the same absolute path
   * on two machines is two different checkouts.
   */
  function groupEntriesByWorktree(entries) {
    var order = [];
    var groups = new Map();
    entries.forEach(function (entry) {
      var root = entry.lease.worktree_root || "";
      // JSON encoding keeps the pair unambiguous without a separator
      // byte that a machine name or path could itself contain.
      var key = JSON.stringify([entry.machine || "", root]);
      if (!groups.has(key)) {
        groups.set(key, { key: key, root: root, machine: entry.machine, entries: [] });
        order.push(key);
      }
      groups.get(key).entries.push(entry);
    });
    return order.map(function (key) {
      return groups.get(key);
    });
  }

  // Live leases are freshness-sorted, so matching sessions can have another
  // agent between them. Coalesce the whole worktree while retaining the first
  // identity appearance and each identity's original session order.
  function groupEntriesByIdentity(entries) {
    var groups = [];
    var groupsByKey = new Map();
    entries.forEach(function (entry) {
      var lease = entry.lease;
      var key = identityKey(
        lease.agent_label,
        lease.agent_id,
        lease.client_surface,
        entry.machine
      );
      var group = groupsByKey.get(key);
      if (!group) {
        group = { key: key, entries: [] };
        groupsByKey.set(key, group);
        groups.push(group);
      }
      group.entries.push(entry);
    });
    return groups;
  }

  // The tier earns its place by distinguishing (the project spans several
  // worktrees) or by warning (one worktree holds several agents, the
  // configuration this whole product exists to make visible). One agent in
  // one checkout gets no extra chrome.
  function needsWorktreeTier(worktrees) {
    if (worktrees.length > 1) return true;
    return worktrees.some(function (worktree) {
      return worktree.entries.length > 1;
    });
  }

  function repoNames(entries) {
    return Array.from(
      entries.reduce(function (names, entry) {
        names.add(repoName(entry.lease));
        return names;
      }, new Set())
    ).sort(function (left, right) {
      return left.localeCompare(right);
    });
  }

  function localMachineLabel(state) {
    return state.hostname || "this machine";
  }

  function machineNames(state) {
    // Machines only become a filter dimension once peers are configured;
    // a single-machine monitor keeps the plain project list.
    if ((state.peers || []).length === 0) return [];
    var names = [localMachineLabel(state)];
    (state.peers || []).forEach(function (peer) {
      var name = peerMachineLabel(peer);
      if (names.indexOf(name) === -1) names.push(name);
    });
    return names;
  }

  function filterLabel() {
    return selectedRepo || selectedMachine;
  }

  function matchesFilter(state, repo, machine) {
    if (selectedRepo && repo !== selectedRepo) return false;
    if (selectedMachine && (machine || localMachineLabel(state)) !== selectedMachine) {
      return false;
    }
    return true;
  }

  function syncProjectFilter(state) {
    var activeRepos = repoNames(leaseEntries(state));
    var repoOptions = activeRepos.slice();
    // Keep a selected project or machine available long enough to clear
    // it when its final agent expires during a live refresh.
    if (selectedRepo && repoOptions.indexOf(selectedRepo) === -1) {
      repoOptions.push(selectedRepo);
    }
    var machines = machineNames(state);
    if (selectedMachine && machines.indexOf(selectedMachine) === -1) {
      machines.push(selectedMachine);
    }
    var signature = JSON.stringify([repoOptions, machines]);
    if (signature !== repoOptionsSignature) {
      var allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = machines.length > 0 ? "All traffic" : "All projects";
      var optionNodes = [allOption];
      // Values are prefix-encoded ("r:" / "m:") so a repository that
      // happens to share a machine's name stays a distinct choice.
      function repoOption(repo) {
        var option = document.createElement("option");
        option.value = "r:" + repo;
        option.textContent = repo;
        return option;
      }
      if (machines.length > 0) {
        var repoGroup = document.createElement("optgroup");
        repoGroup.label = "Projects";
        repoOptions.forEach(function (repo) {
          repoGroup.appendChild(repoOption(repo));
        });
        optionNodes.push(repoGroup);
        var machineGroup = document.createElement("optgroup");
        machineGroup.label = "Machines";
        machines.forEach(function (machine) {
          var option = document.createElement("option");
          option.value = "m:" + machine;
          option.textContent = machine;
          machineGroup.appendChild(option);
        });
        optionNodes.push(machineGroup);
      } else {
        repoOptions.forEach(function (repo) {
          optionNodes.push(repoOption(repo));
        });
      }
      projectFilterSelectEl.replaceChildren.apply(projectFilterSelectEl, optionNodes);
      repoOptionsSignature = signature;
    }
    projectFilterSelectEl.value = selectedRepo
      ? "r:" + selectedRepo
      : selectedMachine
        ? "m:" + selectedMachine
        : "";
    projectFilterEl.hidden =
      activeView !== "agents" ||
      (activeRepos.length < 2 && machines.length < 2 && filterLabel() === "");
  }

  function visibleLeases(state) {
    var entries = leaseEntries(state);
    if (!filterLabel()) return entries;
    return entries.filter(function (entry) {
      return matchesFilter(state, repoName(entry.lease), entry.machine);
    });
  }

  // === Agents view ===

  function renderDirty(lease) {
    if (lease.dirty_count) {
      return lease.dirty_count + " dirty file" + (lease.dirty_count === 1 ? "" : "s");
    }
    if (lease.dirty === true) return "dirty";
    if (lease.dirty === false || lease.dirty_count === 0) return "clean";
    return null;
  }

  function renderPaths(paths, truncated) {
    var list = el("ul", "paths mono");
    paths.forEach(function (path) {
      list.appendChild(el("li", null, path));
    });
    if (truncated > 0) {
      list.appendChild(el("li", null, "and " + truncated + " more"));
    }
    return list;
  }

  function sessionClusterKey(entry) {
    if (!entry.lease.worktree_root) return null;
    // Session relationships only collapse inside one complete display
    // identity: same label, app, machine, and physical checkout.
    return JSON.stringify([
      identityKey(
        entry.lease.agent_label,
        entry.lease.agent_id,
        entry.lease.client_surface,
        entry.machine
      ),
      entry.lease.worktree_root,
    ]);
  }

  function countSessionClusters(entries) {
    var counts = new Map();
    entries.forEach(function (entry) {
      var key = sessionClusterKey(entry);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }

  /** One shared identity line for sessions coalesced inside a worktree. */
  function renderAgentClusterHead(entry, sessionCount) {
    var lease = entry.lease;
    var label = lease.agent_label || lease.agent_id || "Agent";
    var head = el("div", "agent-cluster-head");
    var avatar = el("div", "card-avatar");
    avatar.setAttribute("aria-hidden", "true");
    avatar.appendChild(providerIcon(label, lease.agent_id));
    head.appendChild(avatar);

    var identity = renderAgentIdentity(
      lease.agent_label,
      null,
      lease.client_surface,
      false,
      entry.machine
    );
    identity.appendChild(
      el("span", "agent-cluster-count", sessionCount + " sessions")
    );
    head.appendChild(identity);
    return head;
  }

  /**
   * The identity line for one checkout: its branch, its path, and — the
   * reason this tier exists — how many agents are inside it at once. Two
   * agents in one worktree edit the same files, so that count is the
   * page's clearest collision signal and it reads as emphasis, not alarm:
   * sharing a checkout is normal, it just has to be visible.
   */
  function renderWorktreeHead(worktree, homeDir, showMachine) {
    var lease = worktree.entries[0].lease;
    var head = el("div", "worktree-head");
    var identity = el("div", "worktree-identity");
    // A real subheading under the project's h2, so the page outlines the way
    // it reads: project, then checkout, then the agents inside it.
    identity.appendChild(el("h3", "worktree-branch mono", lease.branch || "detached HEAD"));
    if (worktree.root) {
      var path = el("span", "worktree-path mono", abbreviate(worktree.root, homeDir));
      path.title = worktree.root;
      identity.appendChild(path);
    }
    // The same absolute path on two machines is two checkouts, so the
    // machine names this line — but only when the project actually spans
    // machines. Otherwise every card's origin chip already said it.
    if (worktree.machine && showMachine) {
      identity.appendChild(el("span", "worktree-machine", worktree.machine));
    }
    head.appendChild(identity);
    if (worktree.entries.length > 1) {
      var shared = el(
        "span",
        "worktree-shared",
        worktree.entries.length + " agents in this worktree"
      );
      shared.title =
        "These agents share one checkout, so they edit the same files. Claimed scopes are what keeps them apart.";
      head.appendChild(shared);
    }
    return head;
  }

  /**
   * `grouped` is set when the card sits under a worktree head that already
   * carries its branch, path, and any shared-checkout warning, so the card
   * drops those rather than repeating them on every row.
   */
  function renderCard(entry, sameWorktree, latestEvent, grouped, sharedIdentity) {
    var lease = entry.lease;
    var homeDir = entry.homeDir;
    var cardClass = sharedIdentity ? "card agent-cluster-card" : "card";
    var card = el("article", cardClass);
    var testing = lease.agent_state === "testing";
    var planning = lease.agent_state === "planning";
    // Neither advisory state holds a lock, so both drop the language of
    // claims; they differ in what the paths mean, which the labels below say.
    var advisory = testing || planning;
    card.setAttribute("data-state", advisory ? lease.agent_state : "working");
    var label = lease.agent_label || lease.agent_id || "Agent";
    // The visible identity lives once on the cluster head; name each article
    // as well so article navigation retains the agent/app/machine context.
    if (sharedIdentity) {
      card.setAttribute(
        "aria-label",
        identityDescription(label, lease.agent_id, lease.client_surface, entry.machine)
      );
    }
    if (!sharedIdentity) {
      var avatar = el("div", "card-avatar");
      avatar.setAttribute("aria-hidden", "true");
      avatar.appendChild(providerIcon(label, lease.agent_id));
      card.appendChild(avatar);
    }

    var content = el("div", "card-content");
    var byline = el("div", "card-byline");
    if (sharedIdentity) {
      byline.appendChild(sessionChip(lease.agent_id, label));
    } else {
      byline.appendChild(
        renderAgentIdentity(
          lease.agent_label,
          lease.agent_id,
          lease.client_surface,
          sameWorktree && !grouped,
          entry.machine
        )
      );
    }
    var expiry = el("span", "chip expiry-chip");
    expiry.title = expiryTitle(lease);
    trackTime(expiry, "expiry", lease.expires_at_ms);
    byline.appendChild(expiry);
    content.appendChild(byline);

    if (lease.summary) {
      var bubble = el("div", "speech-bubble agent-bubble");
      bubble.appendChild(summaryLine("summary", lease.emoji, lease.summary));
      content.appendChild(bubble);
    }

    // The agent's last call came back blocked or partial, so it is waiting on
    // (or working around) another agent's claim. Read off the recorded event,
    // not self-reported, and gone the moment a later call is granted.
    if (
      latestEvent &&
      (latestEvent.status === "blocked" || latestEvent.status === "partial") &&
      (latestEvent.blockers || []).length > 0
    ) {
      var waiting = el("div", "waiting-note");
      waiting.setAttribute("data-status", latestEvent.status);
      waiting.title = waitingTitle(latestEvent.blockers);
      waiting.appendChild(
        el(
          "span",
          null,
          waitingText(latestEvent.blockers) +
            (latestEvent.status === "partial" ? " for some scopes" : "")
        )
      );
      content.appendChild(waiting);
    }

    var meta = el("div", "meta");
    if (advisory) meta.appendChild(el("span", "agent-state", lease.agent_state));
    if (lease.branch && !grouped) meta.appendChild(el("span", "mono", lease.branch));
    if (lease.worktree_root && !grouped) {
      meta.appendChild(el("span", "mono path", abbreviate(lease.worktree_root, homeDir)));
    }
    var dirty = renderDirty(lease);
    if (dirty) {
      var dirtyEl = el("span", "dirty", dirty);
      dirtyEl.setAttribute(
        "data-state",
        lease.dirty === true || (lease.dirty_count || 0) > 0 ? "dirty" : "clean"
      );
      meta.appendChild(dirtyEl);
    }
    if (lease.metadata_complete === false) {
      meta.appendChild(el("span", null, "partial git metadata"));
    }
    var updated = el("span", null);
    if (lease.updated_at_ms) {
      trackTime(updated, "age", lease.updated_at_ms, staleAfterMs(lease));
      meta.appendChild(updated);
    }
    if (meta.childNodes.length > 0) content.appendChild(meta);

    var paths = lease.dirty_paths || [];
    if (lease.claims.length > 0 || paths.length > 0) {
      var key =
        (entry.machine || "") + "\u0000" + lease.agent_id + "\u0000" + lease.worktree_root;
      var details = el("details", "agent-details");
      details.agentFrequencyKey = key;
      details.open = openDetails.has(key);
      details.addEventListener("toggle", function () {
        if (details.open) openDetails.add(key);
        else openDetails.delete(key);
      });

      var disclosure = el("summary");
      if (lease.claims.length > 0) {
        disclosure.appendChild(
          el(
            "span",
            null,
            lease.claims.length + " scope" + (lease.claims.length === 1 ? "" : "s")
          )
        );
        var exclusiveCount = lease.claims.filter(function (claim) {
          return claim.access === "exclusive";
        }).length;
        // A testing agent holds no locks, so its paths are an
        // advertisement of what a failing run would blame, not a claim; a
        // planning agent's are only where it is currently reading.
        if (advisory) {
          disclosure.appendChild(el("span", null, "not blocking"));
        } else if (exclusiveCount > 0) {
          disclosure.appendChild(
            el(
              "span",
              "exclusive-count",
              exclusiveCount + " exclusive"
            )
          );
        }
      }
      if (paths.length > 0) {
        var changedPathCount = paths.length + (lease.dirty_paths_truncated || 0);
        disclosure.appendChild(
          el(
            "span",
            null,
            changedPathCount + " changed path" + (changedPathCount === 1 ? "" : "s")
          )
        );
      }
      details.appendChild(disclosure);

      if (lease.claims.length > 0) {
        var claimsSection = el("div", "detail-section");
        claimsSection.appendChild(
          el(
            "p",
            "detail-label",
            planning ? "Areas being read" : testing ? "Scopes under test" : "Claimed scopes"
          )
        );
        var badges = el("div", "badges");
        lease.claims.forEach(function (claim) {
          var badge = el("span", "badge");
          badge.setAttribute("data-access", claim.access === "exclusive" ? "exclusive" : "shared");
          badge.appendChild(el("span", "mono", claim.path));
          badge.appendChild(el("span", "access", claim.access));
          badges.appendChild(badge);
        });
        claimsSection.appendChild(badges);
        details.appendChild(claimsSection);
      }

      if (paths.length > 0) {
        var pathsSection = el("div", "detail-section");
        pathsSection.appendChild(el("p", "detail-label", "Changed paths"));
        pathsSection.appendChild(renderPaths(paths, lease.dirty_paths_truncated));
        details.appendChild(pathsSection);
      }
      content.appendChild(details);
    }

    card.appendChild(content);
    return card;
  }

  function renderAgents(state) {
    var fragment = document.createDocumentFragment();
    var allEntries = leaseEntries(state);
    var entries = visibleLeases(state);
    var groups = groupByRepo(entries);
    var sessionClusters = countSessionClusters(entries);
    var latestEvents = latestEventsByTask(state);
    var tasksByRepo = groupTasksByRepo(visibleTasks(state));
    var recentCount = 0;
    tasksByRepo.forEach(function (tasks) {
      recentCount += tasks.length;
    });

    if (allEntries.length === 0) {
      countEl.textContent = "The frequency is quiet.";
      overviewCopyEl.textContent = !state.database_available
        ? "Nothing has announced on this machine yet."
        : recentCount > 0
          ? "No active leases — here is what recently wrapped up."
          : "No active leases right now.";
      if (recentCount === 0) {
        fragment.appendChild(el("p", "empty", "No active traffic."));
      }
    } else if (entries.length === 0) {
      countEl.textContent =
        "No active agents " + (selectedRepo ? "in " : "on ") + filterLabel() + ".";
      overviewCopyEl.textContent = "Matching traffic will appear as it arrives.";
      if (recentCount === 0) {
        fragment.appendChild(el("p", "empty", "No active agents match this filter."));
      }
    } else {
      var exclusiveCount = entries.reduce(function (total, entry) {
        return (
          total +
          entry.lease.claims.filter(function (claim) {
            return claim.access === "exclusive";
          }).length
        );
      }, 0);
      var machineCount = new Set(
        entries.map(function (entry) {
          return entry.machine || "";
        })
      ).size;
      countEl.textContent = filterLabel()
        ? entries.length +
          " active agent" +
          (entries.length === 1 ? " is" : "s are") +
          " working " +
          (selectedRepo ? "in " : "on ") +
          filterLabel() +
          "."
        : entries.length +
          " active agent" +
          (entries.length === 1 ? " is" : "s are") +
          " working nearby.";
      overviewCopyEl.textContent = filterLabel()
        ? "Filtered from " +
          allEntries.length +
          " active agent" +
          (allEntries.length === 1 ? "" : "s") +
          ", with " +
          (exclusiveCount === 0
            ? "no exclusive scopes claimed."
            : exclusiveCount +
              " exclusive scope" +
              (exclusiveCount === 1 ? "" : "s") +
              " claimed.")
        : groups.length +
          " repositor" +
          (groups.length === 1 ? "y" : "ies") +
          (machineCount > 1 ? " across " + machineCount + " machines" : "") +
          " in view, with " +
        (exclusiveCount === 0
          ? "no exclusive scopes claimed."
          : exclusiveCount +
            " exclusive scope" +
            (exclusiveCount === 1 ? "" : "s") +
            " claimed.");
      groups.forEach(function (group) {
        var section = el("section", "group");
        var head = el("div", "group-head");
        head.appendChild(el("h2", "group-name mono", group.name));
        var recent = tasksByRepo.get(group.name) || [];
        var worktrees = groupEntriesByWorktree(group.entries);
        var tiered = needsWorktreeTier(worktrees);
        var spansMachines =
          new Set(
            worktrees.map(function (worktree) {
              return worktree.machine || "";
            })
          ).size > 1;
        head.appendChild(
          el(
            "p",
            "group-meta",
            group.entries.length +
              " agent" +
              (group.entries.length === 1 ? "" : "s") +
              // Spelling out the spread here is what tells a reader whether
              // those agents are working side by side or in isolation.
              (worktrees.length > 1 ? " in " + worktrees.length + " worktrees" : "") +
              (recent.length > 0 ? " · " + recent.length + " recent" : "")
          )
        );
        section.appendChild(head);

        worktrees.forEach(function (worktree) {
          var host = section;
          if (tiered) {
            host = el("div", "worktree-group");
            host.appendChild(
              renderWorktreeHead(worktree, worktree.entries[0].homeDir, spansMachines)
            );
            section.appendChild(host);
          }
          groupEntriesByIdentity(worktree.entries).forEach(function (identityGroup) {
            var sharedIdentity = identityGroup.entries.length > 1;
            var cardHost = host;
            if (sharedIdentity) {
              cardHost = el("div", "agent-cluster");
              cardHost.appendChild(
                renderAgentClusterHead(identityGroup.entries[0], identityGroup.entries.length)
              );
              host.appendChild(cardHost);
            }
            identityGroup.entries.forEach(function (entry) {
              var clusterKey = sessionClusterKey(entry);
              cardHost.appendChild(
                renderCard(
                  entry,
                  clusterKey !== null && (sessionClusters.get(clusterKey) || 0) > 1,
                  latestEvents.get(
                    taskKey(entry.machine, entry.lease.agent_id, entry.lease.worktree_root)
                  ),
                  tiered,
                  sharedIdentity
                )
              );
            });
          });
        });
        if (recent.length > 0) {
          // Collapsed under live agents: this section already has the
          // content a reader came for, and the head above counts what is
          // hidden.
          renderRecentTasks(section, recent, false);
          tasksByRepo.delete(group.name);
        }
        fragment.appendChild(section);
      });
    }

    // Projects whose agents have all finished still get a section, after
    // the live ones: recent work reads in place rather than in a
    // separate feed at the bottom of the page.
    tasksByRepo.forEach(function (tasks, name) {
      var section = el("section", "group");
      var head = el("div", "group-head");
      head.appendChild(el("h2", "group-name mono", name));
      head.appendChild(
        el(
          "p",
          "group-meta",
          tasks.length + " recent task" + (tasks.length === 1 ? "" : "s")
        )
      );
      section.appendChild(head);
      // Nothing is running here, so the recent tasks are the section:
      // collapsing them would leave a heading and no content.
      renderRecentTasks(section, tasks, true);
      fragment.appendChild(section);
    });

    return fragment;
  }

  // === Activity view ===

  function activityStatus(event) {
    if (event.agent_state === "done") return "claims released";
    if (event.agent_state === "stopped") return "stopped unfinished, claims released";
    // A testing agent keeps its lease but stops locking files, so the
    // scope counts below would read as claims it no longer holds.
    if (event.agent_state === "testing") return "verifying, claims released";
    // A planner never claims, so it never blocks and is never blocked: the
    // scope counts below describe reading, not a hold on anything.
    if (event.agent_state === "planning") return "planning, nothing claimed";
    if (event.requested_scope_count === 0) return "listening only";
    // Recorded blocker identity turns "an active claim" into a name.
    var blockers = event.blockers || [];
    if (event.status === "partial") {
      return blockers.length > 0 ? "partly blocked, " + waitingText(blockers) : "some scopes blocked";
    }
    if (event.status === "blocked") {
      return blockers.length > 0 ? "blocked, " + waitingText(blockers) : "blocked by an active claim";
    }
    return "no known conflict";
  }

  function activityScopes(event) {
    if (
      event.agent_state === "done" ||
      event.agent_state === "stopped" ||
      event.agent_state === "testing" ||
      event.agent_state === "planning"
    ) {
      return null;
    }
    if (event.requested_scope_count === 0) return null;
    if (event.status === "partial") {
      return (
        event.granted_scope_count +
        " clear · " +
        event.blocked_scope_count +
        " blocked"
      );
    }
    if (event.status === "blocked") {
      return (
        event.blocked_scope_count +
        " scope" +
        (event.blocked_scope_count === 1 ? "" : "s") +
        " in conflict"
      );
    }
    return (
      event.granted_scope_count +
      " scope" +
      (event.granted_scope_count === 1 ? "" : "s") +
      " claimed"
    );
  }

  function renderActivity(state) {
    var fragment = document.createDocumentFragment();
    var entries = eventEntries(state);
    // The merged feed keeps the local per-machine bound: newest 200
    // across every machine in view.
    var shown = entries.slice(0, 200);
    var totalCount = totalEventCount(state);
    var truncatedCount = Math.max(0, totalCount - shown.length);

    countEl.textContent =
      totalCount === 0
        ? "No recent calls yet."
        : totalCount + " call" + (totalCount === 1 ? "" : "s") + " on the frequency.";
    overviewCopyEl.textContent =
      totalCount === 0
        ? "Announcements, check-ins, and completions appear here."
        : truncatedCount > 0
          ? "The newest " + shown.length + " calls from the last seven days."
          : "Agents announcing work, checking in, and marking it complete.";

    if (shown.length === 0) {
      fragment.appendChild(el("p", "empty", "The frequency is quiet."));
      return fragment;
    }

    var section = el("section", "group");
    var head = el("div", "group-head");
    head.appendChild(el("h2", "group-name mono", "recent calls"));
    head.appendChild(
      el(
        "p",
        "group-meta",
        truncatedCount > 0
          ? shown.length + " shown · " + truncatedCount + " older"
          : shown.length + " call" + (shown.length === 1 ? "" : "s")
      )
    );
    section.appendChild(head);

    shown.forEach(function (entry) {
      var event = entry.event;
      var call = el("article", "activity-call");
      call.setAttribute(
        "data-state",
        event.agent_state === "done" || event.agent_state === "stopped"
          ? event.agent_state
          : "working"
      );
      var label = event.agent_label || event.agent_id;
      var avatar = el("div", "activity-avatar");
      avatar.setAttribute("aria-hidden", "true");
      avatar.appendChild(
        event.agent_state === "done"
          ? completionIcon()
          : event.agent_state === "stopped"
            ? stopIcon()
            : providerIcon(label, event.agent_id)
      );
      call.appendChild(avatar);

      var message = el("div", "activity-message");
      var byline = el("div", "activity-byline");
      byline.appendChild(el("span", "activity-speaker", label));
      var originTag = originChip(event.client_surface, entry.machine);
      if (originTag) byline.appendChild(originTag);
      byline.appendChild(sessionChip(event.agent_id, label));
      var timestamp = el("time", "activity-age");
      trackTime(timestamp, "event", event.created_at_ms);
      byline.appendChild(timestamp);
      message.appendChild(byline);

      var bubble = el("div", "speech-bubble activity-bubble");
      bubble.appendChild(summaryLine("activity-summary", event.emoji, event.summary));
      message.appendChild(bubble);

      var context = el("div", "activity-context");
      var origin = el("div", "activity-origin");
      origin.appendChild(
        el(
          "span",
          "activity-verb",
          event.agent_state === "done"
            ? "completed work"
            : event.agent_state === "stopped"
              ? "stopped work"
              : event.agent_state === "testing"
                ? "started testing"
                : event.agent_state === "planning"
                  ? "started planning"
                  : event.event_type === "renewed"
                    ? "checked in again"
                    : "announced work"
        )
      );
      origin.appendChild(el("span", null, "in"));
      origin.appendChild(
        el(
          "span",
          "mono",
          (event.repo_name || "unknown repo") + (event.branch ? " / " + event.branch : "")
        )
      );
      context.appendChild(origin);

      var outcome = el("div", "activity-outcome");
      var status = el("span", "activity-status", activityStatus(event));
      status.setAttribute(
        "data-status",
        event.agent_state === "done"
          ? "completed"
          : event.agent_state === "stopped"
            ? "stopped"
            : event.agent_state === "testing"
              ? "testing"
              : event.agent_state === "planning"
                ? "planning"
                : event.status
      );
      if ((event.blockers || []).length > 0) status.title = waitingTitle(event.blockers);
      outcome.appendChild(status);
      if (event.agent_state === "stopped" && event.reason) {
        outcome.appendChild(el("span", "activity-reason", "“" + event.reason + "”"));
      }
      var scopeText = activityScopes(event);
      if (scopeText) outcome.appendChild(el("span", null, scopeText));
      outcome.appendChild(
        el(
          "span",
          null,
          event.peer_count > 0
            ? "heard " +
                event.peer_count +
                " agent" +
                (event.peer_count === 1 ? "" : "s") +
                " nearby"
            : "heard no other agents"
        )
      );
      context.appendChild(outcome);
      message.appendChild(context);
      call.appendChild(message);
      section.appendChild(call);
    });

    fragment.appendChild(section);
    return fragment;
  }

  // === Page chrome and refresh loop ===

  function syncViewTabs() {
    var agentsActive = activeView === "agents";
    agentsTabEl.setAttribute("aria-selected", agentsActive ? "true" : "false");
    agentsTabEl.tabIndex = agentsActive ? 0 : -1;
    activityTabEl.setAttribute("aria-selected", agentsActive ? "false" : "true");
    activityTabEl.tabIndex = agentsActive ? -1 : 0;
    main.setAttribute("aria-labelledby", agentsActive ? "agents-tab" : "activity-tab");
  }

  function setActiveView(view) {
    if (view === activeView) return;
    activeView = view;
    window.history.replaceState(
      null,
      "",
      view === "activity"
        ? window.location.pathname + window.location.search + "#activity"
        : window.location.pathname + window.location.search
    );
    syncViewTabs();
    lastSignature = null;
    if (latestState) render(latestState);
  }

  function renderMachines(state) {
    var peers = state.peers || [];
    machinesEl.hidden = peers.length === 0;
    if (peers.length === 0) {
      machinesEl.replaceChildren();
      return;
    }
    var nodes = [];
    function machineStatus(label, live, title) {
      var status = el("span", "machine-status");
      status.setAttribute("data-state", live ? "live" : "unreachable");
      var dot = el("span", "dot");
      dot.setAttribute("aria-hidden", "true");
      status.appendChild(dot);
      status.appendChild(el("span", null, label));
      if (title) status.title = title;
      return status;
    }
    nodes.push(machineStatus((state.hostname || "this machine") + " · local", true));
    peers.forEach(function (peer) {
      nodes.push(
        machineStatus(
          peerMachineLabel(peer) + (peer.reachable ? "" : " · unreachable"),
          peer.reachable,
          peer.url
        )
      );
    });
    machinesEl.replaceChildren.apply(machinesEl, nodes);
  }

  function render(state) {
    var focusedDetailsKey = null;
    var focusedElement = document.activeElement;
    if (focusedElement && focusedElement.tagName === "SUMMARY") {
      var focusedDetails = focusedElement.closest(".agent-details, .recent-details");
      if (focusedDetails) focusedDetailsKey = focusedDetails.agentFrequencyKey;
    }
    timeNodes = [];
    // replaceChildren momentarily empties the page. If the document
    // shrinks, the browser clamps the scroll position before the new
    // content lands, which reads as the page jumping back to the top
    // mid-read — so the position is restored once the DOM is back.
    var scrollX = window.scrollX;
    var scrollY = window.scrollY;
    syncProjectFilter(state);
    renderMachines(state);
    main.replaceChildren(
      activeView === "activity" ? renderActivity(state) : renderAgents(state)
    );
    if (focusedDetailsKey !== null) {
      Array.prototype.some.call(
        main.querySelectorAll(".agent-details, .recent-details"),
        function (details) {
          if (details.agentFrequencyKey !== focusedDetailsKey) return false;
          var disclosure = details.querySelector("summary");
          if (disclosure) disclosure.focus();
          return true;
        }
      );
    }
    footer.textContent = state.database_available
      ? "Schema v" + (state.schema_version === null ? "?" : state.schema_version)
      : "No state database";
    if ((state.peers || []).length > 0) footer.setAttribute("data-peers", "");
    else footer.removeAttribute("data-peers");
    // After the focus restore above, so a focused summary cannot drag
    // the viewport away from where the reader actually was.
    window.scrollTo(scrollX, scrollY);
  }

  function tick() {
    timeNodes.forEach(applyTime);
    if (failing) {
      setLiveText(lastSuccessMs ? "refresh failed" : "cannot reach monitor");
    } else if (lastSuccessMs) {
      setLiveText("live");
    }
  }

  function setLiveText(text) {
    // The live region should announce state transitions, not a timer tick.
    if (liveTextEl.textContent !== text) liveTextEl.textContent = text;
  }

  function refresh() {
    var basePath = window.location.pathname.replace(/\/?$/, "/");
    fetch(basePath + "api/state", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("bad status " + response.status);
        // Data already refreshes in place. This header also lets an
        // open tab replace its own HTML/CSS after a monitor UI edit.
        var serverUiVersion = response.headers.get("x-agent-frequency-ui-version");
        if (serverUiVersion && serverUiVersion !== UI_VERSION) {
          window.location.reload();
          return null;
        }
        return response.json();
      })
      .then(function (state) {
        if (state === null) return;
        // Countdowns are computed against the server clock so an offset
        // between the browser and the announcing agents cannot make a
        // live lease look expired.
        clockOffsetMs = state.now_ms - Date.now();
        latestState = state;
        lastSuccessMs = Date.now();
        failing = false;
        liveEl.setAttribute("data-state", "ok");
        // Re-render only on real change, so text selection and scroll
        // position survive an idle frequency.
        var signature = JSON.stringify([
          state.database_available,
          state.schema_version,
          activeView,
          selectedRepo,
          selectedMachine,
          state.leases,
          state.event_count,
          state.events_truncated,
          state.events,
          state.hostname,
          state.peers,
        ]);
        if (signature !== lastSignature) {
          lastSignature = signature;
          render(state);
        }
        tick();
      })
      .catch(function () {
        failing = true;
        liveEl.setAttribute("data-state", "error");
        tick();
      });
  }

  // === Wiring ===

  agentsTabEl.addEventListener("click", function () {
    setActiveView("agents");
  });
  activityTabEl.addEventListener("click", function () {
    setActiveView("activity");
  });
  projectFilterSelectEl.addEventListener("change", function () {
    var value = projectFilterSelectEl.value;
    selectedRepo = value.indexOf("r:") === 0 ? value.slice(2) : "";
    selectedMachine = value.indexOf("m:") === 0 ? value.slice(2) : "";
    var url = new URL(window.location.href);
    if (selectedRepo) url.searchParams.set("repo", selectedRepo);
    else url.searchParams.delete("repo");
    if (selectedMachine) url.searchParams.set("machine", selectedMachine);
    else url.searchParams.delete("machine");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    lastSignature = null;
    if (latestState) render(latestState);
  });
  agentsTabEl.parentElement.addEventListener("keydown", function (event) {
    var view =
      event.key === "ArrowLeft" || event.key === "Home"
        ? "agents"
        : event.key === "ArrowRight" || event.key === "End"
          ? "activity"
          : null;
    if (!view) return;
    event.preventDefault();
    setActiveView(view);
    (view === "agents" ? agentsTabEl : activityTabEl).focus();
  });
  syncViewTabs();
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(tick, TICK_MS);
})();
