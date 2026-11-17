/** Same-origin workbench APIs share authentication and error handling. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (response.status === 204) return undefined as T;
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      value?.message ?? value?.error ?? `请求失败（${response.status}）`,
    );
  return value as T;
}
