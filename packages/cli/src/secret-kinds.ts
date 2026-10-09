// The kinds of broker secret, as `secbot secrets add --broker <kind>` types them. A kind names the
// service the secrets cell calls with the secret (a health service or a production service); it
// routes nothing, and no message goes to an agent by it.

/** The `--broker` values: the secrets cell makes these calls itself, never handing over the token. */
export const BROKER_KINDS: readonly string[] = ["health", "production"];
