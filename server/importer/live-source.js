'use strict';

/**
 * The OpenVibe.Live database the importer reads (./live.js): Live's PostgreSQL database (`ov_live`, since
 * 2026-10-08; the SQLite live.db is gone).
 *
 *   openLiveSource({ url })        a pg connection to Live's database. Every read runs in ONE transaction,
 *                                  REPEATABLE READ and READ ONLY, so all the tables come from the same moment
 *                                  (at cutover Live's money writes are frozen first, so that moment is the
 *                                  final state) and nothing can be written through it. close() ends it.
 *   liveSourceFromQuery(query)     the same interface over any (text, params) → rows function (the tests'
 *                                  PGlite).
 *
 * The interface is the one the importer was written against: live.prepare(sql).all(...params) and .get(...),
 * with `?` placeholders. Values arrive as openvibe-sdk/db hands them to Live itself (its PARSERS): ids and other
 * int8 columns as numbers, timestamps as ISO strings. Live's money columns are double precision and its
 * dates are text, so they come through unchanged.
 */
const { PARSERS } = require('openvibe-sdk/db');

/** `?` placeholders → `$1, $2, …` (the importer's Live queries put no `?` inside a string literal). */
function toPg(sql) {
    let n = 0;
    return String(sql).replace(/\?/g, () => `$${++n}`);
}

function liveSourceFromQuery(query, close = async () => {}) {
    return {
        prepare(sql) {
            const text = toPg(sql);
            return {
                all: async (...params) => await query(text, params),
                get: async (...params) => (await query(text, params))[0],
            };
        },
        close,
    };
}

async function openLiveSource({ url, applicationName = 'billing-import-live' }) {
    if (!url) throw new Error('no Live database URL');
    const pg = require('pg');
    const client = new pg.Client({
        connectionString: url,
        application_name: applicationName,
        types: { getTypeParser: (oid, format) => (format === 'text' && PARSERS[oid]) || pg.types.getTypeParser(oid, format) },
    });
    await client.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    } catch (err) {
        await client.end().catch(() => {});
        throw err;
    }
    let closed = false;
    return liveSourceFromQuery(async (text, params) => (await client.query(text, params)).rows, async () => {
        if (closed) return;
        closed = true;
        try { await client.query('ROLLBACK'); } finally { await client.end(); }
    });
}

module.exports = { openLiveSource, liveSourceFromQuery, toPg };
