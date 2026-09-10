export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
export class ApiTimeoutError extends Error {
  constructor() {
    super('A resposta demorou demais. O resultado ainda não foi confirmado.');
  }
}
type ApiOptions = { timeoutMs?: number };
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  apiOptions: ApiOptions = {},
): Promise<T> {
  const options: RequestInit = { method, cache: 'no-store' };
  if (method !== 'GET' && body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const controller = apiOptions.timeoutMs ? new AbortController() : null;
  if (controller) options.signal = controller.signal;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = async () => {
    const response = await fetch('/api/' + path, options);
    const data = (await response.json().catch(() => ({
      error: 'Não foi possível concluir a solicitação.',
    }))) as T & { error?: string; code?: string; requestId?: string };
    if (!response.ok)
      throw new ApiError(
        response.status,
        data.error ?? 'Não foi possível concluir a solicitação.',
        typeof data.code === 'string' ? data.code : undefined,
        typeof data.requestId === 'string' ? data.requestId : undefined,
      );
    return data;
  };
  if (!apiOptions.timeoutMs) return request();
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller?.abort();
          reject(new ApiTimeoutError());
        }, apiOptions.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
export function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Não foi possível concluir. Tente novamente.';
}
