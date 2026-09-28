'use strict';
/**
 * A migrated database for one test (ADR-035), from openvibe-sdk/testing: PGlite by default; with BILLING_TEST_STORE=pg
 * (npm run test:pg) the PostgreSQL + PgBouncer containers, with roles and a schema of its own. The handle's close()
 * also drops the test database.
 */
const { createTestDb } = require('openvibe-sdk/testing');
const { MIGRATIONS } = require('../../server/db');

async function testDb({ store = process.env.BILLING_TEST_STORE || 'pglite', max = 6 } = {}) {
    const t = await createTestDb({ migrations: MIGRATIONS, store, service: 'billing', max });
    const own = t.db.close;
    let closing = null;
    t.db.close = () => { if (!closing) { t.db.close = own; closing = t.close(); } return closing; };
    return t.db;
}

module.exports = { testDb };
