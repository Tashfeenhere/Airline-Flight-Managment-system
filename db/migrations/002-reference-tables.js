/**
 * Migration 002 — reference tables (small, shared dimensions).
 *
 * In Citus these become *reference tables*: fully replicated to every worker so
 * that any distributed query can join them locally, with no network hop and no
 * cross-shard transaction. On vanilla PostgreSQL they are ordinary tables.
 */
module.exports = {
  id: '002',
  name: 'reference_tables',
  target: 'write',
  transactional: true,
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS airlines (
        code       text PRIMARY KEY,
        name       text NOT NULL,
        country    text,
        is_active  boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS airports (
        code       text PRIMARY KEY,
        name       text NOT NULL,
        city       text,
        country    text,
        tz         text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cabins (
        code        text PRIMARY KEY,
        name        text NOT NULL,
        rank        smallint NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS aircraft_types (
        code         text PRIMARY KEY,
        name         text NOT NULL,
        manufacturer text,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
    `);

    // The seat map is deliberately a *template* per aircraft type, not per flight.
    // Materializing seats per flight would mean ~10B rows at 50M flights; instead a
    // flight's seat map is derived by joining its aircraft type against this table
    // and left-joining whatever specific seats are actually held.
    await client.query(`
      CREATE TABLE IF NOT EXISTS seat_map_templates (
        aircraft_type text NOT NULL REFERENCES aircraft_types(code) ON DELETE CASCADE,
        cabin         text NOT NULL REFERENCES cabins(code) ON DELETE CASCADE,
        seat_number   text NOT NULL,
        seat_position text CHECK (seat_position IS NULL OR seat_position IN ('WINDOW','MIDDLE','AISLE')),
        is_exit_row   boolean NOT NULL DEFAULT false,
        PRIMARY KEY (aircraft_type, cabin, seat_number)
      );
    `);

    // ~100k users: small, read-mostly, joined by every authenticated request.
    // A reference table keeps auth a local join on every worker.
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            uuid PRIMARY KEY DEFAULT app_uuidv7(),
        email         text NOT NULL,
        password_hash text NOT NULL,
        role          text NOT NULL DEFAULT 'PASSENGER'
                      CHECK (role IN ('PASSENGER', 'AGENT', 'ADMIN')),
        full_name     text,
        phone         text,
        is_active     boolean NOT NULL DEFAULT true,
        last_login_at timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_users_email UNIQUE (email),
        CONSTRAINT ck_users_email_lowercase CHECK (email = lower(email))
      );
    `);

    // Email is stored lowercase (enforced by the CHECK) so the UNIQUE constraint is
    // effectively case-insensitive without needing the citext extension.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_role ON users (role) WHERE is_active;
    `);
  }
};
