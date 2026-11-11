// Who hears about a birthday (4 Nov 2026): leadership, plus the
// person's own manager. Until then it was five addresses written into
// daily-reminders.js. Leadership is read from access_level, so it stays
// current. Nobody is told about their own birthday, and a manager only
// hears about their own reports.
const norm = (e) => String(e || '').trim().toLowerCase();

function birthdayPeople(employees, month, day) {
  return (employees || []).filter((emp) => {
    if (!emp.date_of_birth) return false;
    const [, m, d] = String(emp.date_of_birth).split('-').map(Number);
    return m === month && d === day;
  });
}

// Map of recipient email -> the birthday people they hear about.
function birthdayRecipients(employees, month, day) {
  const people = birthdayPeople(employees, month, day);
  const out = new Map();
  if (!people.length) return out;
  const add = (email, person) => {
    const e = norm(email);
    if (!e || e === norm(person.email)) return;
    if (!out.has(e)) out.set(e, []);
    if (!out.get(e).includes(person)) out.get(e).push(person);
  };
  const leaders = (employees || []).filter((emp) => ['leadership', 'admin'].includes(emp.access_level));
  for (const person of people) {
    for (const leader of leaders) add(leader.email, person);
    add(person.direct_manager_email, person);
  }
  return out;
}

module.exports = { birthdayPeople, birthdayRecipients };
