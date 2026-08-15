/**
 * Regenerates the README images. Development aid only: nothing here ships in
 * the MCP or the monitor, and it never touches the real state database.
 *
 * Two properties are the reason this is a script rather than a note:
 *
 * - The shots render against a throwaway database seeded with demo fixtures,
 *   so the public README can never leak a real repository or worktree name.
 * - Dark mode and a retina pixel ratio are only reachable over the DevTools
 *   protocol. Chrome's command-line flags cannot emulate prefers-color-scheme
 *   (`--force-dark-mode` inverts the page instead of using its own palette),
 *   and a plain `--screenshot` capture is always 1x, which is what made the
 *   earlier images look small once GitHub scaled them down.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDemoTraffic } from "./demo";
import { startMonitor } from "./monitor";
import { AgentFrequencyStore } from "./store";

/**
 * 4:3 at 2x. The ratio keeps the images from running tall in the README, and
 * capturing at 1400 CSS pixels rather than a wider viewport means GitHub's
 * scaling lands near 1:1 instead of shrinking the text.
 */
const VIEWPORT = { width: 1400, height: 1050, scale: 2 };

const SHOTS = [
  { file: "docs/monitor.png", path: "/" },
  // The filtered view is the only framing where one 4:3 frame holds the whole
  // collision story: a shared worktree, a partial block, and a full block.
  { file: "docs/monitor-worktrees.png", path: "/?repo=acme-web" },
];

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function findChrome(): string {
  const override = process.env.AGENT_FREQUENCY_CHROME;
  if (override) return override;
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  throw new Error(
    "No Chrome or Chromium found. Set AGENT_FREQUENCY_CHROME to the browser binary.",
  );
}

/** Chrome writes its chosen debugging port here when started with port 0. */
async function readDebuggerPort(profileDir: string): Promise<number> {
  const portFile = join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [line] = readFileSync(portFile, "utf8").split("\n");
      if (line) return Number(line);
    } catch {
      // Not written yet.
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome did not report a debugging port");
}

class DevToolsSession {
  private nextId = 1;
  private readonly pending = new Map<number, (result: unknown) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      if (message.id === undefined) return;
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message.result);
      }
    });
  }

  static async open(debuggerPort: number): Promise<DevToolsSession> {
    const target = (await (
      await fetch(`http://127.0.0.1:${debuggerPort}/json/new?about:blank`, { method: "PUT" })
    ).json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    return new DevToolsSession(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  close(): void {
    this.socket.close();
  }
}

async function main(): Promise<void> {
  const chrome = findChrome();
  const scratchDir = mkdtempSync(join(tmpdir(), "agent-frequency-shots-"));
  const dbPath = join(scratchDir, "state.sqlite3");
  const profileDir = join(scratchDir, "chrome");

  const store = new AgentFrequencyStore({ dbPath });
  const seeded = seedDemoTraffic(store);
  store.close();
  console.error(
    `Seeded ${seeded.announcements} demo announcements (${seeded.liveLeases} live) into a scratch database`,
  );

  const monitor = startMonitor({ port: 0, dbPath });
  const browser = Bun.spawn(
    [
      chrome,
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  try {
    const session = await DevToolsSession.open(await readDebuggerPort(profileDir));
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: VIEWPORT.scale,
      mobile: false,
    });
    await session.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await session.send("Page.enable");

    for (const shot of SHOTS) {
      await session.send("Page.navigate", { url: `${monitor.url.replace(/\/$/, "")}${shot.path}` });
      // The page fetches state on load and renders on the response; a fixed
      // wait is enough for a monitor on this machine and keeps this
      // dependency-free.
      await Bun.sleep(3500);
      // A first capture can pick up a stale compositor tile from before the
      // page painted, so one frame is taken and discarded.
      await session.send("Page.captureScreenshot", { format: "png" });
      await Bun.sleep(500);
      const captured = await session.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const target = new URL(`../${shot.file}`, import.meta.url);
      await Bun.write(target, Buffer.from(captured.data, "base64"));
      console.error(
        `Wrote ${shot.file} at ${VIEWPORT.width}x${VIEWPORT.height} @${VIEWPORT.scale}x (dark)`,
      );
    }
    session.close();
  } finally {
    browser.kill();
    await monitor.stop();
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
