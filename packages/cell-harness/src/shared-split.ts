/**
 * Who pays a shared job's cost. Each person pays half; when one person's monthly budget is used up,
 * the other pays all; when both are, the cost is halved again, so spend that ran is never dropped
 * (the household holds a job while both are over, so that is rare).
 */

const MICROS = 1_000_000;

export type Split = "half" | "all";

/**
 * Splits one charge between the requesting and the other person, to the micro-dollar; the odd
 * micro-dollar of a half goes to the requesting person. `over` tells whether a person's budget is
 * used up.
 */
export function splitCharge(
  usd: number,
  requester: string,
  other: string,
  over: (person: string) => boolean,
): { shares: Record<string, number>; split: Split } {
  const micros = Math.max(0, Math.round(usd * MICROS));
  const requesterOver = over(requester);
  const otherOver = over(other);
  if (requesterOver !== otherOver) {
    return {
      shares: {
        [requester]: requesterOver ? 0 : micros / MICROS,
        [other]: otherOver ? 0 : micros / MICROS,
      },
      split: "all",
    };
  }
  const otherHalf = Math.floor(micros / 2);
  return {
    shares: { [requester]: (micros - otherHalf) / MICROS, [other]: otherHalf / MICROS },
    split: "half",
  };
}

/** Who pays, from one person's side: half each, this person all (`you`), or the other (`them`). */
export function payerOf(
  role: "requester" | "other",
  requesterOver: boolean,
  otherOver: boolean,
): "half" | "you" | "them" {
  if (requesterOver === otherOver) return "half";
  const meOver = role === "requester" ? requesterOver : otherOver;
  return meOver ? "them" : "you";
}
