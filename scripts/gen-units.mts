#!/usr/bin/env node
/** Rewrite deploy/agent-threads*.service from daemon/cmd/units.ts (the test fails when they drift). */
import { writeFileSync } from 'node:fs';
import { CANONICAL_BUNDLE, CANONICAL_NODE, renderUnit } from '../daemon/cmd/units.ts';

writeFileSync('deploy/agent-threads.service', renderUnit({ variant: 'system', node: CANONICAL_NODE, bundle: CANONICAL_BUNDLE }));
writeFileSync('deploy/agent-threads.user.service', renderUnit({ variant: 'user', node: CANONICAL_NODE, bundle: CANONICAL_BUNDLE }));
console.log('wrote deploy/agent-threads.service and deploy/agent-threads.user.service');
