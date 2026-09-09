export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const options: RequestInit = { method, cache: 'no-store' };
  if (method !== 'GET' && body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/api/' + path, options);
  const data = (await response
    .json()
    .catch(() => ({
      error: 'Não foi possível concluir a solicitação.',
    }))) as T & { error?: string };
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error ?? 'Não foi possível concluir a solicitação.',
    );
  return data;
}
export function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Não foi possível concluir. Tente novamente.';
}
