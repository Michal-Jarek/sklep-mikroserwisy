import { isByteLength, isEmail } from 'class-validator';

// Rules shared by the request DTOs and the first admin account from the environment (decision 9).
export const EMAIL_MAX_LENGTH = 254;
// bcrypt ignores everything after 72 bytes, so longer passwords are rejected instead of cut.
export const PASSWORD_MIN_BYTES = 10;
export const PASSWORD_MAX_BYTES = 72;

/** Emails are stored and compared trimmed and in lower case. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Same check as @IsEmail() + @MaxLength(254) in the DTOs; expects a normalized email. */
export function isValidEmail(email: string): boolean {
  return email.length <= EMAIL_MAX_LENGTH && isEmail(email);
}

/** Password length counted in UTF-8 bytes (a Polish letter is 2 bytes). */
export function isValidPasswordLength(password: string): boolean {
  return isByteLength(password, PASSWORD_MIN_BYTES, PASSWORD_MAX_BYTES);
}
