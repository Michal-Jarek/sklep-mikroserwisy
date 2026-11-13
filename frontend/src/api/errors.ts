// Every failed request becomes an ApiError (decision 13). The customer sees a Polish message chosen
// by the error code (docs/decisions.md D7 and the code register, Gateway README "Kody błędów",
// docs/frontend-api.md); an unknown code or a non-JSON response falls back to the HTTP status.

/** Code of an ApiError when the request got no HTTP response (no connection, 15 s timeout). */
export const NETWORK_ERROR = 'NETWORK_ERROR';

export interface ApiErrorInit {
  /** HTTP status; 0 for a network error. */
  status: number;
  code: string;
  /** Technical message from the response (English, for developers). Never shown to the customer. */
  message: string;
  requestId: string | null;
  /** Seconds from the `Retry-After` header. */
  retryAfter: number | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAfter: number | null;

  constructor(init: ApiErrorInit) {
    super(init.message || `HTTP ${init.status}`);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
  }
}

/** Where the error happened, for messages that depend on the action (decision 13). */
export type ErrorContext = 'review' | 'cart';

const SEND_FAILED = 'Nie udało się wysłać żądania.';
const UNAVAILABLE = 'Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.';
const UNEXPECTED = 'Wystąpił nieoczekiwany błąd.';
const INVALID_INPUT = 'Sprawdź wprowadzone dane.';

/** Messages by `error` code. TOO_MANY_* need the wait time, see errorMessage(). */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  VALIDATION_ERROR: INVALID_INPUT,
  BAD_REQUEST: INVALID_INPUT,
  INVALID_CREDENTIALS: 'Nieprawidłowy e-mail lub hasło.',
  EMAIL_TAKEN: 'Konto z tym adresem e-mail już istnieje.',
  TOO_MANY_ATTEMPTS: 'Konto jest czasowo zablokowane. Spróbuj ponownie później.',
  TOO_MANY_REQUESTS: 'Zbyt wiele prób. Spróbuj ponownie za chwilę.',
  // 401 is handled by the session (refresh or the login page); this text is a fallback.
  UNAUTHORIZED: 'Zaloguj się, aby kontynuować.',
  FORBIDDEN: 'Nie masz uprawnień do tej operacji.',
  NOT_FOUND: 'Nie znaleziono.',
  CONFLICT: 'Operacja koliduje z aktualnym stanem danych.',
  INSUFFICIENT_STOCK: 'Za mało sztuk w magazynie.',
  PRODUCT_UNAVAILABLE: 'Produkt z koszyka nie jest już dostępny. Usuń go z koszyka.',
  CART_EMPTY: 'Koszyk jest pusty.',
  ORDER_NOT_CANCELLABLE: 'Tego zamówienia nie można już anulować.',
  INVALID_STATUS_TRANSITION: 'Nie można zmienić statusu przesyłki w ten sposób.',
  PAYLOAD_TOO_LARGE: SEND_FAILED,
  REQUEST_HEADER_FIELDS_TOO_LARGE: SEND_FAILED,
  REQUEST_TIMEOUT: SEND_FAILED,
  METHOD_NOT_ALLOWED: SEND_FAILED,
  UNSUPPORTED_MEDIA_TYPE: SEND_FAILED,
  BAD_GATEWAY: UNAVAILABLE,
  SERVICE_UNAVAILABLE: UNAVAILABLE,
  GATEWAY_TIMEOUT: UNAVAILABLE,
  [NETWORK_ERROR]: UNAVAILABLE,
  INTERNAL_ERROR: UNEXPECTED,
  INTERNAL_SERVER_ERROR: UNEXPECTED,
  // Set by the client when a successful response is not JSON.
  INVALID_RESPONSE: UNEXPECTED,
};

const CONTEXT_MESSAGES: Record<ErrorContext, Partial<Record<number, string>>> = {
  review: {
    403: 'Opinię może dodać tylko osoba, która kupiła ten produkt.',
    409: 'Ten produkt już oceniłeś.',
  },
  cart: {
    409: 'Za mało sztuk w magazynie.',
  },
};

function messageByStatus(status: number): string {
  if (status === 0 || status === 502 || status === 503 || status === 504) return UNAVAILABLE;
  if (status >= 500) return UNEXPECTED;
  if (status === 400 || status === 422) return INVALID_INPUT;
  if (status === 401) return ERROR_MESSAGES.UNAUTHORIZED;
  if (status === 403) return ERROR_MESSAGES.FORBIDDEN;
  if (status === 404) return ERROR_MESSAGES.NOT_FOUND;
  if (status === 409) return ERROR_MESSAGES.CONFLICT;
  if (status === 429) return ERROR_MESSAGES.TOO_MANY_REQUESTS;
  return SEND_FAILED;
}

/** Polish message for the customer. Non-ApiError values (bugs in our code) get the generic message. */
export function errorMessage(error: unknown, context?: ErrorContext): string {
  if (!(error instanceof ApiError)) return UNEXPECTED;

  const contextual = context ? CONTEXT_MESSAGES[context][error.status] : undefined;
  if (contextual) return contextual;

  if (error.code === 'TOO_MANY_ATTEMPTS' && error.retryAfter !== null) {
    return `Konto jest czasowo zablokowane. Spróbuj ponownie za ${Math.ceil(error.retryAfter / 60)} min.`;
  }
  if (error.code === 'TOO_MANY_REQUESTS' && error.retryAfter !== null) {
    return `Zbyt wiele prób. Spróbuj ponownie za ${error.retryAfter} s.`;
  }
  // A code known for a different status (e.g. a service answering 400 with "NOT_FOUND") still gets its text.
  return ERROR_MESSAGES[error.code] ?? messageByStatus(error.status);
}

/** True for errors worth retrying by the user ("Spróbuj ponownie"): no connection, 502/503/504. */
export function isTemporaryError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504);
}
