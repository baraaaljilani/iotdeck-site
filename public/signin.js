// Sign-in and sign-up page
(() => {
  const form = document.getElementById('form');
  const errorEl = document.getElementById('error');
  const submitBtn = document.getElementById('submit');
  const nameField = document.getElementById('name-field');
  const title = document.getElementById('auth-title');
  const password = document.getElementById('password');
  let mode = 'signin';

  // If already signed in, go straight to the dashboard
  fetch('/api/me', { credentials: 'same-origin' })
    .then((r) => { if (r.ok) location.replace('/dashboard'); })
    .catch(() => {});

  function setMode(next) {
    mode = next;
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
    });
    const signup = mode === 'signup';
    nameField.hidden = !signup;
    title.textContent = signup ? 'Create your account' : 'Welcome back';
    submitBtn.textContent = signup ? 'Create account' : 'Sign in';
    password.autocomplete = signup ? 'new-password' : 'current-password';
    errorEl.textContent = '';
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const data = Object.fromEntries(new FormData(form));
    const email = String(data.email || '').trim();
    if (!email || !data.password) {
      errorEl.textContent = 'Enter your email and password.';
      return;
    }
    if (mode === 'signup' && data.password.length < 10) {
      errorEl.textContent = 'Password must be at least 10 characters.';
      return;
    }

    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = 'Please wait…';
    try {
      const res = await fetch(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password: data.password, name: data.name || '' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        errorEl.textContent = body.error || 'Something went wrong. Please try again.';
        return;
      }
      location.replace('/dashboard');
    } catch {
      errorEl.textContent = 'Network problem. Check your connection and try again.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
})();
