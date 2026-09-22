export const REQUEST_TIMEOUT_MS = 15_000;

export class RequestTimeoutError extends Error {
  constructor() {
    super("The game server took too long to respond. Check your connection and try again.");
    this.name = "RequestTimeoutError";
  }
}

/** The deadline includes downloading the body, not just receiving response headers. */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestTimeoutError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        return { response, text: await response.text() };
      })(),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
