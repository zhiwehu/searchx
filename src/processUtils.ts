import { spawn, type ChildProcess } from "node:child_process";

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => child.kill());
    return;
  }

  child.kill("SIGKILL");
}
