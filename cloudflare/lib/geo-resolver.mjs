/**
 * @fileoverview Adaptador ESM para Cloudflare Pages de GeographicResolver
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const resolver = require('../../lib/geo-resolver.js');

export const resolveLocation = resolver.resolveLocation;
export const enrichEvent = resolver.enrichEvent;
export const enrichEvents = resolver.enrichEvents;
export const haversineKm = resolver.haversineKm;
export const calculateBearing = resolver.calculateBearing;
export const CARTOGRAPHY_METADATA = resolver.CARTOGRAPHY_METADATA;

export default resolver;
