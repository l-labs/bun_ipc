/**
 * Shared plumbing for the deep test suite: server discovery, a
 * subprocess harness (so a native crash fails one test instead of
 * killing the whole runner), and sacrificial-server spawning for
 * robustness tests.
 */
import { LConnection } from "../src/index";

export const PORT = parseInt(process.env.L_TEST_PORT || "5001");
export const BUN = process.execPath;                    // the running bun
export const ROOT = `${import.meta.dir}/..`;            // repo root

/** Is an L server answering on this port? */
export function serverUp(port: number = PORT): boolean {
  try {
    const c = LConnection.connect("localhost", port);
    c.close();
    return true;
  } catch {
    return false;
  }
}

// A server binary for tests that need to kill their own server.
// Set L_BIN to the `l` executable; robustness tests that spawn a
// sacrificial server skip when it is unset (see robustness.test.ts).
export const L_BIN: string | null = process.env.L_BIN ?? null;

/**
 * Run a snippet in a fresh bun subprocess with the client library
 * imported as `LConnection` etc. and `PORT` defined. Returns exit
 * status and output; a segfault shows up as signalCode, not as a
 * dead test runner.
 */
export function runSub(code: string): {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
} {
  const preamble =
    `import { LConnection, lib, LType, jsToL, lToJs, ` +
    `B, G, H, I, J, E, F, C, S, D, T, Z, ` +
    `vG, vH, vI, vJ, vE, vF, vS, vD, vT, vZ, vC } from "./src/index";\n` +
    `const PORT = ${PORT};\n`;
  const p = Bun.spawnSync([BUN, "-e", preamble + code], {
    cwd: ROOT,
    env: { ...process.env },
  });
  return {
    exitCode: p.exitCode,
    signalCode: (p as any).signalCode ?? null,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  };
}

/** Spawn a sacrificial L server and wait until it answers. */
export async function spawnServer(
  port: number,
): Promise<ReturnType<typeof Bun.spawn>> {
  if (!L_BIN) throw new Error("no L server binary (set L_BIN)");
  const proc = Bun.spawn([L_BIN, "-p", String(port)], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (serverUp(port)) return proc;
    await Bun.sleep(50);
  }
  proc.kill();
  throw new Error(`sacrificial server on ${port} never came up`);
}

/** Kill a sacrificial server and wait for the port to free up. */
export async function killServer(
  proc: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  proc.kill(9);
  await proc.exited;
}
