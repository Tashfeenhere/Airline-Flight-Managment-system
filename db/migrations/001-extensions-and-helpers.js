/**
 * Migration 001 — extensions, UUIDv7 shim, and partition helpers.
 *
 * Portability contract: the same migration set must apply to
 *   (a) a Citus cluster (production),
 *   (b) a vanilla PostgreSQL 18 (local dev / CI on this machine).
 * Everything database-specific is therefore feature-detected, never assumed.
 *
 * UUIDv7: PostgreSQL 18 ships a native `uuidv7()`. Older servers (Citus 14 images
 * are built on PG 16/17) do not, so `app_uuidv7()` is defined here to use the
 * native function when present and otherwise fall back to a plpgsql
 * implementation. Application code always supplies its own UUIDv7, so this is a
 * safety net for ad-hoc SQL and bulk loaders — but it must be correct anyway.
 */
module.exports = {
  id: '001',
  name: 'extensions_and_helpers',
  // Applied to both databases: the read model needs the partition helpers too, and
  // the UUIDv7 shim is used by ad-hoc SQL and bulk loaders on either side.
  target: 'all',
  // Citus DDL cannot be assumed transactional across all versions; every
  // statement here is idempotent, so each runs in autocommit.
  transactional: false,
  async up(client) {
    await client.query(`
      DO $$
      BEGIN
        -- gen_random_uuid() is built in from PG13, but pgcrypto is still useful
        -- for digest()/hmac() in reporting queries.
        IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto') THEN
          CREATE EXTENSION IF NOT EXISTS pgcrypto;
        END IF;
      END
      $$;
    `);

    // --- UUIDv7 -------------------------------------------------------------
    // Portable fallback: 48-bit big-endian millisecond timestamp + version 7 +
    // RFC 4122 variant (10), so the byte layout is a real UUIDv7 and remains
    // time-sortable even without the native function.
    await client.query(`
      CREATE OR REPLACE FUNCTION app_uuidv7_fallback() RETURNS uuid
      LANGUAGE plpgsql VOLATILE AS $$
      DECLARE
        v_hex   text;
        v_rand  bytea;
        v_byte  int;
      BEGIN
        -- 12 hex digits of milliseconds since the Unix epoch.
        v_hex := lpad(to_hex((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint), 12, '0');
        -- 10 random bytes taken from a v4 UUID (no extension required).
        v_rand := substring(uuid_send(gen_random_uuid()) from 7 for 10);
        v_hex := v_hex || encode(v_rand, 'hex');

        -- Set the version nibble (position 13) to 7.
        v_hex := substr(v_hex, 1, 12) || '7' || substr(v_hex, 14);
        -- Set the variant nibble (position 17) to one of 8,9,a,b.
        v_byte := 8 + (get_byte(v_rand, 7) % 4);
        v_hex := substr(v_hex, 1, 16) || to_hex(v_byte) || substr(v_hex, 18);

        RETURN v_hex::uuid;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7') THEN
          EXECUTE $fn$
            CREATE OR REPLACE FUNCTION app_uuidv7() RETURNS uuid
            LANGUAGE sql VOLATILE AS 'SELECT uuidv7()';
          $fn$;
        ELSE
          EXECUTE $fn$
            CREATE OR REPLACE FUNCTION app_uuidv7() RETURNS uuid
            LANGUAGE sql VOLATILE AS 'SELECT app_uuidv7_fallback()';
          $fn$;
        END IF;
      END $$;
    `);

    // --- Partition lifecycle helpers ---------------------------------------
    // pg_partman is optional. When it is absent (vanilla PostgreSQL, and some
    // Citus images) these helpers do the same job with plain DDL, so partition
    // management never depends on an extension being installable.
    await client.query(`
      CREATE OR REPLACE FUNCTION app_ensure_month_partitions(
        p_parent       text,
        p_months_behind int DEFAULT 1,
        p_months_ahead  int DEFAULT 6
      ) RETURNS int
      LANGUAGE plpgsql AS $$
      DECLARE
        v_month     date;
        v_start     date;
        v_end       date;
        v_partition text;
        v_created   int := 0;
      BEGIN
        v_month := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_months_behind))::date;
        FOR i IN 0..(p_months_behind + p_months_ahead) LOOP
          v_start := (v_month + make_interval(months => i))::date;
          v_end   := (v_start + interval '1 month')::date;
          v_partition := p_parent || '_p' || to_char(v_start, 'YYYYMM');

          IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = v_partition AND n.nspname = current_schema()
          ) THEN
            EXECUTE format(
              'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
              v_partition, p_parent, v_start, v_end
            );
            v_created := v_created + 1;
          END IF;
        END LOOP;

        RETURN v_created;
      END $$;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION app_drop_partitions_older_than(
        p_parent     text,
        p_older_than date
      ) RETURNS int
      LANGUAGE plpgsql AS $$
      DECLARE
        v_partition text;
        v_dropped   int := 0;
      BEGIN
        FOR v_partition IN
          SELECT c.relname
            FROM pg_inherits i
            JOIN pg_class c ON c.oid = i.inhrelid
            JOIN pg_class p ON p.oid = i.inhparent
           WHERE p.relname = p_parent
             AND c.relname ~ ('^' || p_parent || '_p[0-9]{6}$')
             AND to_date(right(c.relname, 6), 'YYYYMM') < p_older_than
        LOOP
          EXECUTE format('DROP TABLE %I', v_partition);
          v_dropped := v_dropped + 1;
        END LOOP;

        RETURN v_dropped;
      END $$;
    `);
  }
};
