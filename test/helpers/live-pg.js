'use strict';

/**
 * A fabricated OpenVibe.Live database for the importer tests: PGlite (PostgreSQL, as Live's ov_live is) with Live's
 * money tables in the column types its migrations give them (bigint ids and amounts, double precision balances,
 * text dates). Values come back through openvibe-sdk/db's PARSERS, as they do from the real database.
 *
 *   const live = await fakeLive();          // the tables, empty
 *   await live.exec('INSERT …');            // set it up, or change it between two imports
 *   importLive(ctx, { live: live.source(), … })
 */
const { PGlite } = require('@electric-sql/pglite');
const { PARSERS } = require('openvibe-sdk/db');
const { liveSourceFromQuery } = require('../../server/importer/live-source');

// The columns the importer reads, as OpenVibe.Live's migrations/0002_live.sql creates them.
const LIVE_MONEY_TABLES = `
    CREATE TABLE users (id bigint PRIMARY KEY, username text UNIQUE NOT NULL, openvibe_bucks_balance double precision DEFAULT 0.00,
        openvibe_coins_balance bigint DEFAULT 0, openvibe_bucks_cashout_balance double precision DEFAULT 0.00);
    CREATE TABLE transactions (id bigint PRIMARY KEY, from_user_id bigint, to_user_id bigint, stream_id bigint,
        amount bigint NOT NULL, type text NOT NULL CHECK(type IN ('donation', 'purchase', 'subscription', 'cashout', 'refund', 'bonus')),
        status text DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'failed', 'escrow', 'refunded')), message text,
        paypal_transaction_id text, created_at text);
    CREATE TABLE payment_orders (id bigint PRIMARY KEY, user_id bigint NOT NULL, provider text NOT NULL, provider_ref text,
        kind text NOT NULL DEFAULT 'bucks', amount_cents bigint NOT NULL DEFAULT 0, currency text DEFAULT 'usd', bucks bigint DEFAULT 0,
        streamer_id bigint, status text DEFAULT 'pending', created_at text, updated_at text);
    CREATE TABLE subscriptions (id bigint PRIMARY KEY, subscriber_id bigint NOT NULL, streamer_id bigint NOT NULL, tier bigint DEFAULT 1,
        is_active bigint DEFAULT 1, started_at text, expires_at text, provider text, provider_ref text,
        price_cents bigint DEFAULT 0, currency text DEFAULT 'usd', status text DEFAULT 'active', cancel_at_period_end bigint DEFAULT 0,
        auto_renew bigint DEFAULT 0, current_period_end text, created_at text, updated_at text);
    CREATE TABLE site_settings (key text PRIMARY KEY, value text NOT NULL DEFAULT '', description text DEFAULT '', type text DEFAULT 'string', updated_at text);
    CREATE TABLE powerchat_connections (user_id bigint PRIMARY KEY, powerchat_username text, powerchat_user_id text, updated_at text);
`;

async function fakeLive({ tables = LIVE_MONEY_TABLES } = {}) {
    const parsers = {};
    for (const [oid, fn] of Object.entries(PARSERS)) parsers[oid] = (v) => fn(v);
    const pg = new PGlite(undefined, { parsers });
    await pg.waitReady;
    if (tables) await pg.exec(tables);
    return {
        exec: async (sql) => { await pg.exec(sql); },
        query: async (text, params = []) => (await pg.query(text, params, { parsers })).rows,
        source: () => liveSourceFromQuery(async (text, params) => (await pg.query(text, params, { parsers })).rows),
        close: async () => { await pg.close(); },
    };
}

module.exports = { fakeLive, LIVE_MONEY_TABLES };
