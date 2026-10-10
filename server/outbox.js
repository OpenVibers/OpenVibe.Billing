'use strict';

/**
 * Transactional outbox (events.event-envelope@1). enqueue() is called inside the same
 * transaction as the money movement it announces, so an event exists exactly when its effect
 * does. openvibe-sdk/events stores and relays the envelope from service_outbox.
 */
const { ids, validate } = require('openvibe-contracts');

const ACTOR = { type: 'service', id: 'billing' };

/** actor defaults to the service itself; staff actions pass the person ({ type: 'user', id }). */
async function enqueue(ctx, { event_type, subject, payload, priority = 'important', traceId, actor }) {
    const ms = ctx.now();
    const env = {
        event_id: ids.newId('event', ms),
        event_type,
        version: 1,
        source: 'billing',
        actor: actor || ACTOR,
        timestamp: new Date(ms).toISOString(),
        priority,
        visibility: 'internal',
        subject,
        payload: payload || {},
    };
    if (traceId && /^[0-9a-f]{32}$/.test(traceId)) env.trace_id = traceId;
    const v = validate('events.event-envelope@1', env);
    if (!v.valid) throw new Error(`outbox: invalid envelope for ${event_type}: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    await ctx.outbox.emit(env);
    return env;
}

module.exports = { enqueue };
