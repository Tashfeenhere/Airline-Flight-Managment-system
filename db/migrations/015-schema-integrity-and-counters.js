/**
 * Migration 015 — Schema integrity, sold_seats counter equality, durable idempotency,
 * load manifest, dead-letter events, and auth challenges.
 *
 * Requirements addressed:
 * - Add sold_seats column to flight_inventory
 * - Update capacity constraint to strict equality: available_seats + held_seats + sold_seats = total_seats
 * - Durable idempotency_records table in PostgreSQL
 * - Dead-letter events table (dead_letter_events)
 * - Load manifest table (load_manifest)
 * - Auth challenges table (auth_challenges) for 2FA tracking and rate-limiting
 * - Email outbox table (email_outbox) for async resilient email dispatch
 */
const citus = require('../../src/db/citus');

module.exports = {
  id: '015',
  name: 'schema_integrity_and_counters',
  target: 'write',
  transactional: false,
  async up(client) {
    // 1. Add sold_seats column to flight_inventory (without inline CHECK constraint for Citus compatibility)
    await client.query(`
      ALTER TABLE flight_inventory
      ADD COLUMN IF NOT EXISTS sold_seats integer NOT NULL DEFAULT 0;
    `);

    // Backfill sold_seats from existing historical bookings or diff
    await client.query(`
      UPDATE flight_inventory
      SET sold_seats = GREATEST(0, total_seats - (available_seats + held_seats))
      WHERE sold_seats = 0 AND (available_seats + held_seats) < total_seats;
    `);

    // Replace the loose '<=' check constraint with strict equality
    await client.query(`
      ALTER TABLE flight_inventory
      DROP CONSTRAINT IF EXISTS inv_capacity;
    `);

    await client.query(`
      ALTER TABLE flight_inventory
      ADD CONSTRAINT inv_capacity
      CHECK (available_seats + held_seats + sold_seats = total_seats);
    `);

    // 2. Durable Idempotency Records table
    await client.query(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        idempotency_key       text NOT NULL,
        scope                 text NOT NULL,
        request_fingerprint   text NOT NULL,
        status                text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
        response_status       integer,
        response_body         jsonb,
        response_headers      jsonb,
        expires_at            timestamptz NOT NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (scope, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_idempotency_expiry
        ON idempotency_records (expires_at);
    `);

    // 3. Dead Letter Events (DLQ)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dead_letter_events (
        id                    uuid PRIMARY KEY DEFAULT app_uuidv7(),
        event_id              uuid,
        event_type            text NOT NULL,
        aggregate_type        text NOT NULL,
        aggregate_id          text NOT NULL,
        payload               jsonb NOT NULL,
        error_message         text NOT NULL,
        error_stack           text,
        attempts              integer NOT NULL DEFAULT 1,
        resolved              boolean NOT NULL DEFAULT false,
        resolved_at           timestamptz,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_dlq_unresolved
        ON dead_letter_events (event_type, created_at)
        WHERE NOT resolved;
    `);

    // 4. Load Manifest (for deterministic resumable 50M bulk loaders)
    await client.query(`
      CREATE TABLE IF NOT EXISTS load_manifest (
        chunk_id              text PRIMARY KEY,
        chunk_date            date NOT NULL,
        status                text NOT NULL CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED')),
        flight_count          integer NOT NULL DEFAULT 0,
        inventory_count       integer NOT NULL DEFAULT 0,
        booking_count         integer NOT NULL DEFAULT 0,
        checksum              text,
        duration_ms           integer,
        error_message         text,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      );
    `);

    // 5. Auth Challenges (Email 2FA Challenge state authoritative in Postgres)
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_challenges (
        challenge_id          uuid PRIMARY KEY DEFAULT app_uuidv7(),
        user_id               uuid,
        email                 text NOT NULL,
        challenge_type        text NOT NULL CHECK (challenge_type IN ('REGISTER', 'LOGIN', 'SENSITIVE_ACTION')),
        code_hash             text NOT NULL,
        salt                  text NOT NULL,
        attempts              integer NOT NULL DEFAULT 0,
        max_attempts          integer NOT NULL DEFAULT 5,
        resend_count          integer NOT NULL DEFAULT 0,
        last_sent_at          timestamptz NOT NULL DEFAULT now(),
        expires_at            timestamptz NOT NULL,
        verified              boolean NOT NULL DEFAULT false,
        locked                boolean NOT NULL DEFAULT false,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_auth_challenges_lookup
        ON auth_challenges (email, challenge_type, verified, locked);
    `);

    // 6. Email Outbox (reliable asynchronous email delivery)
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_outbox (
        email_id              uuid PRIMARY KEY DEFAULT app_uuidv7(),
        recipient             text NOT NULL,
        subject               text NOT NULL,
        body_text             text NOT NULL,
        body_html             text NOT NULL,
        challenge_id          uuid,
        status                text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
        attempts              integer NOT NULL DEFAULT 0,
        max_attempts          integer NOT NULL DEFAULT 5,
        last_error            text,
        next_attempt_at       timestamptz NOT NULL DEFAULT now(),
        sent_at               timestamptz,
        created_at            timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
        ON email_outbox (next_attempt_at)
        WHERE status = 'PENDING';
    `);

    // Distribute reference tables if Citus is active
    const state = await citus.distributionState(client);
    if (state.canDistribute) {
      await citus.makeReference(client, 'idempotency_records');
      await citus.makeReference(client, 'dead_letter_events');
      await citus.makeReference(client, 'load_manifest');
      await citus.makeReference(client, 'auth_challenges');
      await citus.makeReference(client, 'email_outbox');
    }
  }
};
