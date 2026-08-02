import type {
  AssessmentInput,
  AssessmentResult,
  ErrorResponse,
} from '../../shared/types';

/**
 * Same-origin by default: the Express server serves both the API and this
 * bundle, so there is no base URL to configure and no CORS to debug.
 */
const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function assess(input: AssessmentInput): Promise<AssessmentResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/assess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      (payload as ErrorResponse | null)?.error ?? `Request failed (${res.status})`,
    );
  }

  return payload as AssessmentResult;
}
