// Request-access form for the landing page (public/landing.html). Posts JSON
// to /api/request-access and renders the outcome; without a configured intake
// it offers the contact address the server returns.
(function () {
  var form = document.getElementById('access-form');
  var result = document.getElementById('access-result');
  var submit = document.getElementById('access-submit');
  if (!form || !result || !submit) return;

  function show(kind, text, mailto) {
    result.className = 'result ' + kind;
    result.textContent = '';
    result.appendChild(document.createTextNode(text));
    if (mailto) {
      result.appendChild(document.createTextNode(' '));
      var a = document.createElement('a');
      a.href = 'mailto:' + mailto + '?subject=' + encodeURIComponent('NucMonitor partner access request');
      a.textContent = mailto;
      result.appendChild(a);
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var email = form.email.value.trim();
    var organization = form.organization.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { show('err', 'Enter a valid work email.'); form.email.focus(); return; }
    if (!organization) { show('err', 'Tell us which organisation you are with.'); form.organization.focus(); return; }

    submit.disabled = true;
    show('', 'Sending…');
    var payload = {
      email: email,
      organization: organization,
      role: form.role.value,
      message: form.message.value.trim(),
      website: form.website.value,
    };
    fetch('/api/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      if (r.status === 202) {
        show('ok', 'Thanks. Your request is in; we will reply to ' + email + '.');
        form.reset();
      } else if (r.status === 503) {
        show('warn', r.body && r.body.contact
          ? 'Request intake is not switched on for this deployment yet. Email us instead:'
          : 'Request intake is not switched on for this deployment yet. Please try again later or use the contact in the repository README.',
          r.body && r.body.contact);
      } else if (r.status === 429) {
        show('warn', 'Too many requests from this network. Please try again in an hour.');
      } else if (r.status === 400) {
        show('err', 'Please check the email and organisation fields.');
      } else {
        show('err', 'Something went wrong (' + r.status + '). Please try again.');
      }
    }).catch(function () {
      show('err', 'Could not reach the server. Check your connection and try again.');
    }).then(function () {
      submit.disabled = false;
    });
  });
})();
