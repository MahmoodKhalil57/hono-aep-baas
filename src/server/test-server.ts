import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type TestServer = {
  origin: string;
  stop: () => void;
};

/**
 * Boots the real Bun server as a subprocess against a throwaway copy of the
 * database.
 *
 * The server is Bun-native (`bun:sqlite`), so it cannot be imported into a
 * Node-hosted vitest run. Driving the actual binary is also the more honest
 * test: pieces are generated from the API's own OpenAPI document, so they
 * should be proven against the API as it really runs.
 */
export async function startTestServer(
  /** Extra env for the child — e.g. pointing a provider client at a stub. */
  extraEnv: Record<string, string> = {},
): Promise<TestServer> {
  const directory = mkdtempSync(join(tmpdir(), "baas-test-"));
  const databasePath = join(directory, "test.sqlite");
  const source = "data/baas.sqlite";

  copyFileSync(source, databasePath);
  // The database runs in WAL mode, so recent writes (including the seed) can
  // still live in the -wal sidecar. Copy it too and let SQLite replay it;
  // without this the copy opens as an empty-but-valid database. The -shm file
  // is deliberately skipped — SQLite rebuilds it.
  if (existsSync(`${source}-wal`)) {
    copyFileSync(`${source}-wal`, `${databasePath}-wal`);
  }

  const child: ChildProcess = spawn("bun", ["src/server/index.ts"], {
    env: { ...process.env, PORT: "0", DATABASE_PATH: databasePath, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stop = () => {
    child.kill();
    rmSync(directory, { recursive: true, force: true });
  };

  const origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error("Timed out waiting for the test server to start"));
    }, 15_000);

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/running at (http:\/\/\S+)/);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(new URL(match[1]).origin);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Test server exited with code ${code}:\n${output}`));
    });
  });

  return { origin, stop };
}
