import type { CommandRunner } from "../lib/command";

export interface MemorySnapshot {
  freePercent: number | null;
  swapUsedMb: number | null;
}

/** Reads macOS memory pressure so the pipeline can log it and warn before the image stage (never blocks). */
export class MemoryAdvisor {
  constructor(
    private readonly runner: CommandRunner,
    private readonly bins = { memoryPressure: "/usr/bin/memory_pressure", sysctl: "/usr/sbin/sysctl" },
  ) {}

  async snapshot(): Promise<MemorySnapshot> {
    const [mp, sw] = await Promise.all([
      this.runner.run(this.bins.memoryPressure, [], { timeoutMs: 8000 }).catch(() => undefined),
      this.runner.run(this.bins.sysctl, ["-n", "vm.swapusage"], { timeoutMs: 5000 }).catch(() => undefined),
    ]);
    const free = mp?.stdout.match(/free percentage:\s+(\d+)%/);
    const swap = sw?.stdout.match(/used = ([\d.]+)M/);
    return { freePercent: free ? Number(free[1]) : null, swapUsedMb: swap ? Number(swap[1]) : null };
  }
}
