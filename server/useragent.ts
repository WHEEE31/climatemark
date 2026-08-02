/**
 * Single source of truth for how ClimateMark identifies itself upstream.
 *
 * Several of the free services we depend on — Nominatim above all — require a
 * contact address and return 403 to clients that don't supply one. Previously
 * this string was hardcoded in seven modules, which meant setting the
 * environment variable fixed only some of them.
 */
export const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ??
  'ClimateMark/1.0 (property climate risk; contact: noreply@example.com)';
