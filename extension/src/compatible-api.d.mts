export type CompatibleApiOperation = "models" | "translation";

export interface CompatibleApiIssue {
  title: string;
  detail: string;
}

export class CompatibleApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly providerMessage?: string;
  readonly cause?: unknown;
  constructor(code: string, options?: {
    status?: number;
    providerMessage?: string;
    cause?: unknown;
  });
}

export function normalizeCompatibleApiBaseUrl(value: string): string;
export function buildCompatibleApiUrl(baseUrl: string, resource: string): string;
export function compatibleApiOriginPattern(baseUrl: string): string;
export function buildCompatibleApiHeaders(
  apiKey: string,
  includeJson?: boolean,
): Record<string, string>;
export function extractModelIds(payload: unknown): string[];
export function compatibleApiResponseError(response: Response): Promise<CompatibleApiError>;
export function describeCompatibleApiError(
  error: unknown,
  operation?: CompatibleApiOperation,
): CompatibleApiIssue;
