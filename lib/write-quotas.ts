export const DEFAULT_WRITE_QUOTAS = {
  ownedDocuments: 100,
  commentsPerDocument: 500,
  activeSharesPerDocument: 100,
} as const;

export type WriteQuotaEnvironment = {
  MAX_OWNED_DOCUMENTS?: string;
  MAX_COMMENTS_PER_DOCUMENT?: string;
  MAX_ACTIVE_SHARES_PER_DOCUMENT?: string;
};

type WriteQuotaName = keyof WriteQuotaEnvironment;

export class WriteQuotaError extends Error {
  constructor(
    public status: 409 | 503,
    public code: 'quota_exceeded' | 'quota_configuration_invalid',
    message: string,
  ) {
    super(message);
  }
}

function configuredLimit(
  environment: WriteQuotaEnvironment,
  name: WriteQuotaName,
  fallback: number,
) {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value))
    throw new WriteQuotaError(
      503,
      'quota_configuration_invalid',
      'O limite desta escrita está configurado de forma inválida.',
    );
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new WriteQuotaError(
      503,
      'quota_configuration_invalid',
      'O limite desta escrita está configurado de forma inválida.',
    );
  return parsed;
}

export function ownedDocumentLimit(environment: WriteQuotaEnvironment) {
  return configuredLimit(
    environment,
    'MAX_OWNED_DOCUMENTS',
    DEFAULT_WRITE_QUOTAS.ownedDocuments,
  );
}

export function commentLimit(environment: WriteQuotaEnvironment) {
  return configuredLimit(
    environment,
    'MAX_COMMENTS_PER_DOCUMENT',
    DEFAULT_WRITE_QUOTAS.commentsPerDocument,
  );
}

export function activeShareLimit(environment: WriteQuotaEnvironment) {
  return configuredLimit(
    environment,
    'MAX_ACTIVE_SHARES_PER_DOCUMENT',
    DEFAULT_WRITE_QUOTAS.activeSharesPerDocument,
  );
}

export function quotaExceeded(message: string) {
  return new WriteQuotaError(409, 'quota_exceeded', message);
}
