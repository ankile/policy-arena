const K = 32;

/**
 * Compute new ELO ratings after a match.
 * scoreA: 1 for A wins, 0 for A loses, 0.5 for draw
 */
export function computeEloUpdate(
  ratingA: number,
  ratingB: number,
  scoreA: number
): [number, number] {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;

  const newA = ratingA + K * (scoreA - expectedA);
  const newB = ratingB + K * (scoreB - expectedB);

  return [Math.round(newA * 100) / 100, Math.round(newB * 100) / 100];
}
