#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails
 * if any of them fails. They use in-process stubs of OpenVibe.Network, OpenVibe.Events and the
 * payment providers, temp databases and random ports; none needs the network or a running service.
 *
 *   npm test                     # everything
 *   npm test -- import webhooks  # only files whose name contains one of the words
 *   npm test -- --strict         # a skipped test fails the run too
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 */
'use strict';
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 60000, pad: 28, parallel: 1 });
