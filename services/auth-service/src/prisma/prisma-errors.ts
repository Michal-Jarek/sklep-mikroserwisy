/** Prisma error code (e.g. "P2002"), when the error has one. */
export function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * Unique constraint violated (P2002), e.g. an email that is already registered.
 * Do not log such errors: the database message can contain the conflicting value.
 */
export function isUniqueViolation(error: unknown): boolean {
  return prismaErrorCode(error) === 'P2002';
}
