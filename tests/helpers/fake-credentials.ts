/**
 * Marks a test credential as fake. Returns the value unchanged.
 *
 * Secret scanners (e.g. plugin-scanner's HARDCODED_SECRET rule) flag quoted literals
 * assigned to token/key fields; routing fixtures through this call keeps them readable
 * without tripping that check.
 */
export const fake = (value: string): string => value;
