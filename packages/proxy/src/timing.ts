// Microsecond elapsed time helper, shared by the wrapper and the frame
// processor. Resolution: process.hrtime.bigint() truncated to microseconds.

export function elapsedUs(startNs: bigint): number {
  return Number((process.hrtime.bigint() - startNs) / 1000n);
}
