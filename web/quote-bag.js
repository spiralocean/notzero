// Shuffle-bag for the header quotes: random order, every quote shown once before any repeats — plus a recency
// guard at the SEAM between bags, which is where the naive version leaked.
//
// A plain bag is not enough, and the failure was visible in use. Within one bag every quote is distinct, but
// nothing connected one bag to the next: a quote drawn near the END of a bag could be drawn near the START of
// the following one. Simulated over 5,000 draws of 70 quotes, the old version's closest repeat was 2 apart,
// with ~1% of repeats under 10 apart — about one obvious repeat every 25 minutes of watching, which reads as
// "these are repeating before I've seen them all" however correct the within-bag shuffle is.
//
// So the last `recentWindow` draws are parked at the FRONT of each new bag. Draws come off the END, so those
// come round last rather than next, putting a floor under the gap: same simulation, closest repeat 13 apart.
//
// Split into its own module so it can be tested without a browser — app.js needs a canvas and a live page.
export function makeQuoteBag(count, recentWindow = 12, rand = Math.random) {
  let bag = [], recent = [];
  const next = (curr) => {
    if (!bag.length) {
      const all = Array.from({ length: count }, (_, i) => i);
      for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
      // No history on the very first refill, but there IS a current quote — don't follow it with itself.
      const seen = new Set(recent.length ? recent : (curr == null ? [] : [curr]));
      bag = [...all.filter((i) => seen.has(i)), ...all.filter((i) => !seen.has(i))];
    }
    const pick = bag.pop();
    recent.unshift(pick);
    if (recent.length > recentWindow) recent.length = recentWindow;
    return pick;
  };
  next.remaining = () => bag.length;
  return next;
}
