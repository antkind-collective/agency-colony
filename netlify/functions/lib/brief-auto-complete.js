// Delivered briefs close themselves (Alex + Mara, 30 Sep 2026) — pure logic.
//
// the client now answers a delivery: "Approve delivery" (-> completed) or "Request
// changes" (-> under_revision). A delivery nobody answers for
// AUTO_COMPLETE_DAYS calendar days counts as accepted, so Your Agency's Delivered
// column never piles up and nobody at Your Agency clicks Complete any more. A
// paused brief never closes itself.
//
// `deliveredAt` maps brief id -> ISO time it most recently ENTERED delivered
// (brief_status_history, the open row). A re-delivery after a revision
// restarts the clock.

const AUTO_COMPLETE_DAYS = 7;
const DAY_MS = 86400000;

function autoCompleteDue(briefs, deliveredAt, nowIso) {
  const now = new Date(nowIso).getTime();
  return (briefs || []).filter((b) => {
    if (b.status !== 'delivered' || b.paused_at) return false;
    const at = deliveredAt.get(b.id);
    if (!at) return false; // no delivery record: leave it for a human
    return now - new Date(at).getTime() >= AUTO_COMPLETE_DAYS * DAY_MS;
  });
}

module.exports = { autoCompleteDue, AUTO_COMPLETE_DAYS };
