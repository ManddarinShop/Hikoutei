/** Compatibility-named inbound polling supervisor. */

import {
  SyncTaskSupervisor,
  type SyncTaskWait,
} from "./SyncTaskSupervisor.js";

export type SyncPollingWait = SyncTaskWait;

type PollPass<Report> = () => Promise<Report>;

export interface SyncPollingSupervisorOptions<Report = unknown> {
  readonly runPass: PollPass<Report>;
  readonly intervalMs?: number;
  readonly errorBackoffInitialMs?: number;
  readonly errorBackoffMaxMs?: number;
  readonly wait?: SyncPollingWait;
  readonly onReport?: (report: Report) => void;
  readonly onError?: (error: unknown) => void;
}

/** Preserves the existing polling API while delegating lifecycle behavior. */
export class SyncPollingSupervisor<Report = unknown> extends SyncTaskSupervisor<Report> {
  public constructor(options: SyncPollingSupervisorOptions<Report>) {
    super({
      name: "poll",
      stoppedName: "polling",
      runPass: options.runPass,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.errorBackoffInitialMs === undefined
        ? {}
        : { errorBackoffInitialMs: options.errorBackoffInitialMs }),
      ...(options.errorBackoffMaxMs === undefined
        ? {}
        : { errorBackoffMaxMs: options.errorBackoffMaxMs }),
      ...(options.wait === undefined ? {} : { wait: options.wait }),
      ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
  }
}
