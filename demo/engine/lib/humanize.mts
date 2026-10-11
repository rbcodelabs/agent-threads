/** Deterministic "human" jitter, so re-takes look the same unless the script changes. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-character delays: base +/- 35% jitter, with a longer beat after spaces and punctuation. */
export function typingDelays(text: string, baseMs: number, seed = 1): number[] {
  const random = mulberry32(seed);
  return Array.from(text).map((char) => {
    const jitter = 1 + (random() - 0.5) * 0.7;
    const beat = char === " " ? 1.6 : /[.,!?]/.test(char) ? 2.2 : 1;
    return Math.round(baseMs * jitter * beat);
  });
}

/** Ease-in-out so the cursor accelerates and settles instead of sliding at constant speed. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
