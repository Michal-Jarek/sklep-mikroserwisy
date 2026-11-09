import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginRequest, RegisterRequest } from './auth.dto';

// Same options as the global ValidationPipe.
const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

const VALID = { email: 'anna@example.com', password: 'correct-horse-42', firstName: 'Anna', lastName: 'Nowak' };

async function register(overrides: Record<string, unknown>) {
  const dto = plainToInstance(RegisterRequest, { ...VALID, ...overrides });
  const errors = await validate(dto, OPTIONS);
  return { dto, failed: errors.map((error) => error.property) };
}

// local part 64 + "@" + domain; labels up to 63 characters.
function emailOfLength(length: number): string {
  const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(length - 64 - 1 - 63 - 1 - 63 - 1 - 4)}.com`;
  return `${'a'.repeat(64)}@${domain}`;
}

describe('RegisterRequest', () => {
  it('accepts a valid request', async () => {
    expect((await register({})).failed).toEqual([]);
  });

  it('trims the email and stores it in lower case', async () => {
    const { dto, failed } = await register({ email: '  Anna.Nowak@Example.COM ' });
    expect(failed).toEqual([]);
    expect(dto.email).toBe('anna.nowak@example.com');
  });

  it('accepts an email of 254 characters and rejects 255', async () => {
    expect(emailOfLength(254)).toHaveLength(254);
    expect((await register({ email: emailOfLength(254) })).failed).toEqual([]);
    expect((await register({ email: emailOfLength(255) })).failed).toEqual(['email']);
  });

  it('rejects an invalid email or a value of another type', async () => {
    expect((await register({ email: 'nie-email' })).failed).toEqual(['email']);
    expect((await register({ email: 42 })).failed).toEqual(['email']);
  });

  it('counts the password length in UTF-8 bytes: 10-72', async () => {
    expect((await register({ password: 'a'.repeat(9) })).failed).toEqual(['password']);
    expect((await register({ password: 'a'.repeat(10) })).failed).toEqual([]);
    expect((await register({ password: 'a'.repeat(72) })).failed).toEqual([]);
    expect((await register({ password: 'a'.repeat(73) })).failed).toEqual(['password']);
  });

  it('counts a Polish letter as 2 bytes', async () => {
    const a = '\u0105'; // Polish "a with ogonek", 2 bytes in UTF-8
    // 5 characters, 9 bytes
    expect((await register({ password: a.repeat(4) + 'a' })).failed).toEqual(['password']);
    // 5 characters, 10 bytes
    expect((await register({ password: a.repeat(5) })).failed).toEqual([]);
    // 36 characters, 72 bytes
    expect((await register({ password: a.repeat(36) })).failed).toEqual([]);
    // 37 characters, 74 bytes
    expect((await register({ password: a.repeat(37) })).failed).toEqual(['password']);
  });

  it('does not trim the password', async () => {
    const { dto } = await register({ password: '  correct-horse-42  ' });
    expect(dto.password).toBe('  correct-horse-42  ');
  });

  it('trims names and requires 1-100 characters', async () => {
    const { dto, failed } = await register({ firstName: '  Anna ', lastName: 'x'.repeat(100) });
    expect(failed).toEqual([]);
    expect(dto.firstName).toBe('Anna');
    expect((await register({ firstName: '   ' })).failed).toEqual(['firstName']);
    expect((await register({ lastName: 'x'.repeat(101) })).failed).toEqual(['lastName']);
  });

  it.each([
    ['NUL', 'A\u0000'],
    ['CR/LF', 'A\r\nBcc: x@example.com'],
    ['a tab', 'Anna\tMaria'],
    ['a lone surrogate', 'A\ud800'],
  ])('rejects names with %s (control characters, unpaired surrogates)', async (_case, name) => {
    expect((await register({ firstName: name })).failed).toEqual(['firstName']);
    expect((await register({ lastName: name })).failed).toEqual(['lastName']);
  });

  it('says which name is invalid, without the value', async () => {
    const dto = plainToInstance(RegisterRequest, { ...VALID, firstName: 'A\u0000' });
    const [error] = await validate(dto, OPTIONS);
    expect(Object.values(error.constraints ?? {})).toEqual(['firstName must not contain control characters or unpaired surrogates']);
  });

  it.each([
    'Zo\u00eb', // "Zoe" with a diaeresis
    '\u0141ucja', // Polish name starting with "L with stroke"
    "O'Neil",
    'Anna-Maria',
    'Anna Maria',
    'Ana \u{1F600}', // a character outside the BMP (a valid surrogate pair)
  ])('accepts the name %s', async (name) => {
    expect((await register({ firstName: name, lastName: name })).failed).toEqual([]);
  });

  it('checks the name after trimming: CR/LF around it is removed, not rejected', async () => {
    const { dto, failed } = await register({ firstName: '\r\nAnna\r\n' });
    expect(failed).toEqual([]);
    expect(dto.firstName).toBe('Anna');
  });

  it('requires all fields', async () => {
    const dto = plainToInstance(RegisterRequest, { email: 'anna@example.com', password: 'correct-horse-42', firstName: 'A' });
    const errors = await validate(dto, OPTIONS);
    expect(errors.map((error) => error.property)).toEqual(['lastName']);
  });

  it('rejects unknown fields such as roles', async () => {
    const { failed } = await register({ roles: ['ADMIN'] });
    expect(failed).toEqual(['roles']);
  });
});

describe('LoginRequest', () => {
  async function login(body: Record<string, unknown>) {
    const dto = plainToInstance(LoginRequest, body);
    const errors = await validate(dto, OPTIONS);
    return { dto, failed: errors.map((error) => error.property) };
  }

  it('normalizes the email like the registration', async () => {
    const { dto, failed } = await login({ email: ' K15.User@Example.com ', password: 'x' });
    expect(failed).toEqual([]);
    expect(dto.email).toBe('k15.user@example.com');
  });

  it('rejects an empty password and one over 72 bytes (bcrypt would ignore the rest)', async () => {
    expect((await login({ email: 'a@example.com', password: '' })).failed).toEqual(['password']);
    expect((await login({ email: 'a@example.com', password: 'a'.repeat(73) })).failed).toEqual(['password']);
  });
});
