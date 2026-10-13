import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "./state-database-coordinator.js";

describe("state lifecycle coordinator runtime directory", () => {
  it("keeps macOS coordinator files out of /tmp, which tmp_cleaner empties of untouched files", () => {
    const locks = path.join(
      os.userInfo().homedir,
      "Library",
      "Application Support",
      "OpenClaw",
      "locks",
    );
    const { directory, coordinatorPath } = withMockedPlatform("darwin", () => {
      const runtimeDirectory = resolveStateLifecycleRuntimeDirectory();
      return {
        directory: runtimeDirectory,
        coordinatorPath: resolveStateDatabaseCoordinatorPath({
          databasePath: path.join(os.homedir(), ".openclaw", "state", "openclaw.sqlite"),
          runtimeDirectory,
          uid: 501,
        }),
      };
    });
    expect(directory).toBe(locks);
    expect(coordinatorPath).toContain(
      path.join("Library", "Application Support", "OpenClaw", "locks", "openclaw-state-locks-501"),
    );
    expect(/^\/(private\/)?tmp\//.test(coordinatorPath)).toBe(false);
  });

  it("keeps the process temp directory on Linux", () => {
    expect(withMockedPlatform("linux", () => resolveStateLifecycleRuntimeDirectory())).toBe("/tmp");
  });
});
