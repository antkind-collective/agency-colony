// Shared holiday lookup for the reminder crons.
//
// The crons already skip weekends; they did not skip Your Agency public holidays,
// so the team was being nudged on Diwali and Independence Day (Alex,
// 24 Aug 2026 — same pass that made every computed deadline respect them).
// Holidays are IST dates in app.public_holidays.

async function isHolidayInIst(supabase, runAt, istDateString) {
  const iso = istDateString || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(runAt);
  const { data, error } = await supabase
    .from('public_holidays')
    .select('holiday_date, name')
    .eq('holiday_date', iso)
    .maybeSingle();
  // Fail OPEN: a lookup error must not silence a legitimate nudge.
  if (error) return null;
  return data ? { date: data.holiday_date, name: data.name } : null;
}

module.exports = { isHolidayInIst };
