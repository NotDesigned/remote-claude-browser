/** How long a page gets to answer a gateway's own inspection before it counts as not answering. */
export const PAGE_EVALUATE_TIMEOUT_MS = 1500;

type Send = (
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * The value of `expression` evaluated in a page. Rejects with `timeoutMessage` when the page does
 * not answer within `timeoutMs`: a hung renderer must not hold up the caller.
 */
export async function evaluateInPage(
  send: Send,
  sessionId: string,
  expression: string,
  timeoutMessage: string,
  timeoutMs = PAGE_EVALUATE_TIMEOUT_MS,
): Promise<unknown> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const response = (await Promise.race([
      send(sessionId, "Runtime.evaluate", { expression, returnByValue: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        timeout.unref?.();
      }),
    ])) as { result?: { value?: unknown } } | undefined;
    return response?.result?.value;
  } finally {
    clearTimeout(timeout);
  }
}
