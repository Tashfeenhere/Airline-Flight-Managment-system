/**
 * Migration 011 — tie `confirmed_at` to the CONFIRMED status.
 *
 * The cancel path has to choose between two different seat-return statements: `reclaim`
 * for a booking whose seat was sold, `release` for a booking whose seat is still held.
 * Neither is an error when aimed at the wrong state — each is guarded, and each simply
 * updates zero rows — so the wrong choice strands a seat silently. The choice is
 * therefore made from the status of the row the claim just updated, and the discriminator
 * is `confirmed_at IS NOT NULL`.
 *
 * That discriminator is only sound if the database keeps it sound. These two constraints
 * do exactly that, for the two statuses a claim can read:
 *
 *   CONFIRMED -> confirmed_at IS NOT NULL   a sale is stamped with when it happened
 *   PENDING   -> confirmed_at IS NULL       a hold has not been sold yet
 *
 * Together they make `confirmed_at IS NOT NULL` mean *precisely* "was CONFIRMED" across
 * the states `claimForCancel` accepts, which is what lets the claim return the answer
 * atomically instead of the caller trusting a read that may already be stale.
 *
 * Deliberately one-directional on the CONFIRMED side: a CANCELLED row KEEPS its
 * `confirmed_at`, because that timestamp is how a later reader still knows the seat was
 * once sold. An equivalence over all four statuses would forbid that and destroy the
 * history. An EXPIRED row is likewise unconstrained — it can only be reached from
 * PENDING (so it carries no timestamp), but pinning that here would make the reaper's
 * claim and this constraint two places that must agree about a transition that cannot
 * happen.
 *
 * `transactional: false` for the same reason migration 007 uses it: Citus refuses DDL
 * inside a distributed transaction, and adding a constraint to a distributed table is
 * distributed DDL.
 *
 * Nothing to do for existing rows — both predicates already hold across the cluster —
 * but they are written as validating constraints rather than `NOT VALID`, so a database
 * that somehow disagrees refuses the migration instead of silently keeping a
 * discriminator the application now depends on.
 */
module.exports = {
  id: '011',
  name: 'booking_confirmed_timestamp',
  target: 'write',
  transactional: false,
  async up(client) {
    // Guarded on the catalog for the same reason every other migration here is: a
    // re-run after a partial failure must be a no-op rather than an error.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ck_bookings_confirmed_timestamp'
        ) THEN
          ALTER TABLE bookings
            ADD CONSTRAINT ck_bookings_confirmed_timestamp
            CHECK (status <> 'CONFIRMED' OR confirmed_at IS NOT NULL);
        END IF;
      END
      $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ck_bookings_pending_timestamp'
        ) THEN
          ALTER TABLE bookings
            ADD CONSTRAINT ck_bookings_pending_timestamp
            CHECK (status <> 'PENDING' OR confirmed_at IS NULL);
        END IF;
      END
      $$;
    `);
  }
};
