/**
 * Exit checks start a probe egress (a proxy process) per request. These bound how many run at
 * once, per user and in all, so that repeated clicks or scripted requests cannot start them
 * without limit.
 */
import { ProxyCatalogError } from "./catalog";

export const MAX_EXIT_CHECKS_PER_USER = 2;
export const MAX_EXIT_CHECKS = 8;

export type ExitCheckLimiter = ReturnType<typeof createExitCheckLimiter>;

export function createExitCheckLimiter(limits: { perUser?: number; total?: number } = {}) {
  const perUser = limits.perUser ?? MAX_EXIT_CHECKS_PER_USER;
  const total = limits.total ?? MAX_EXIT_CHECKS;
  const running = new Map<string, number>();
  let all = 0;
  return {
    /** Runs one check for the user, or refuses with 429 when too many are already running. */
    async run<T>(userId: string, check: () => Promise<T>): Promise<T> {
      const mine = running.get(userId) ?? 0;
      if (mine >= perUser || all >= total)
        throw new ProxyCatalogError(
          429,
          "EXIT_CHECK_BUSY",
          "出口检查进行中，请等当前检查完成后再试",
        );
      running.set(userId, mine + 1);
      all++;
      try {
        return await check();
      } finally {
        all--;
        const left = (running.get(userId) ?? 1) - 1;
        if (left > 0) running.set(userId, left);
        else running.delete(userId);
      }
    },
    /** Checks running now (tests). */
    get running() {
      return all;
    },
  };
}
