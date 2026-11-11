// Sign-in choices for a self-hosted Colony. The installer records which ones
// this site uses; a method that isn't set up never shows.
(async function emailLogin() {
  let cfg;
  try { cfg = await (await fetch('/api/runtime-config')).json(); } catch (e) { return; }
  if (cfg.loginGoogle === undefined) return;
  if (!cfg.loginGoogle) {
    for (const el of document.querySelectorAll('#staffAuthActions, #staffAuthHelp, #invitedEntrance')) el.style.display = 'none';
  }
  if (!cfg.loginEmail) return;
  const status = document.getElementById('loginMessage');
  const form = document.createElement('form');
  form.className = 'auth-actions';
  form.innerHTML = '<label for="emailLoginInput">Work email</label><input id="emailLoginInput" type="email" required autocomplete="email"><button type="submit" class="google-btn">Email me a sign-in link</button>';
  status.parentNode.insertBefore(form, status);
  const say = (text, cls) => { status.textContent = text; status.className = `status ${cls}`; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    const { error } = await state.supabase.auth.signInWithOtp({
      email: form.querySelector('input').value.trim(),
      options: { emailRedirectTo: `${location.origin}${location.pathname}` }
    });
    button.disabled = false;
    if (error) say(`Couldn't send the link: ${error.message}`, 'error');
    else say('Check your email and open the link in this browser.', 'success');
  });
}());
