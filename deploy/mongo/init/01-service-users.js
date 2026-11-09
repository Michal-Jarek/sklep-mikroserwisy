// Creates a MongoDB user for each service with a document database:
// user <s>_service in database <s>_db (authSource = <s>_db), role readWrite on that database only.
// The password comes from variable <S>_DB_PASSWORD (e.g. REVIEW_DB_PASSWORD).
//
// Runs automatically on the first container start (empty volume), from /docker-entrypoint-initdb.d,
// as the admin account. Can be run again, e.g. after changing passwords in deploy/.env (see
// "Reset" in deploy/README.md). Idempotent: an existing user gets the password and roles from here.
//
// Passwords are never printed.

const services = [
  ["review_db", "review_service", "REVIEW_DB_PASSWORD"],
  ["notification_db", "notification_service", "NOTIFICATION_DB_PASSWORD"],
];

// Check all passwords first so the server is never left half-configured.
for (const [, , variable] of services) {
  if (!process.env[variable]) {
    throw new Error(`${variable} is not set`);
  }
}

for (const [database, user, variable] of services) {
  const target = db.getSiblingDB(database);
  const roles = [{ role: "readWrite", db: database }];
  if (target.getUser(user)) {
    target.updateUser(user, { pwd: process.env[variable], roles });
    print(`updated ${user} in ${database}`);
  } else {
    target.createUser({ user, pwd: process.env[variable], roles });
    print(`created ${user} in ${database}`);
  }
}
