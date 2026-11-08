import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireAnalysisLock } from "../src/analysis-lock";

test("analysis lock excludes another process for the same database and releases on close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-lock-"));
  const db = join(dir, "one.sqlite");
  const lock = acquireAnalysisLock(db);
  try {
    const script = `import { acquireAnalysisLock } from './src/analysis-lock'; const lock = acquireAnalysisLock(process.argv[1]); lock.close();`;
    let child = Bun.spawn([process.execPath, "-e", script, db], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    const other = Bun.spawn(
      [process.execPath, "-e", script, join(dir, "other.sqlite")],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await other.exited).toBe(0);
    lock.close();
    child = Bun.spawn([process.execPath, "-e", script, db], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
  } finally {
    lock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis lock is released after the holder is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-lock-crash-"));
  const db = join(dir, "db.sqlite");
  const script = `import { acquireAnalysisLock } from './src/analysis-lock'; acquireAnalysisLock(process.argv[1]); console.log('ready'); setInterval(() => {}, 1000);`;
  const child = Bun.spawn([process.execPath, "-e", script, db], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "ready",
    );
    expect(() => acquireAnalysisLock(db)).toThrow();
    child.kill("SIGKILL");
    await child.exited;
    const lock = acquireAnalysisLock(db);
    lock.close();
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
