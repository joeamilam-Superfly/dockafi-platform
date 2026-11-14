'use strict';

var PORTAL_RECOVERY = null;

function jwtSub(token) {
  try {
    var part = String(token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var json = JSON.parse(decodeURIComponent(escape(atob(part))));
    return json.sub || '';
  } catch (e) {
    return '';
  }
}

function longDate(iso) {
  if (!iso) return '';
  var bits = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(bits[0], bits[1] - 1, bits[2])).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });
}

function coverageWord(status) {
  if (status === 'cancelled' || status === 'canceled') return 'Canceled';
  if (status === 'suspended') return 'Suspended';
  if (status === 'active') return 'Active';
  return status || 'Unknown';
}

function portalMount() {
  return document.getElementById('screen-portal');
}

function showPortalFrame() {
  window.PORTAL_MODE = true;
  showScreen('screen-portal');
}

async function resolveRole() {
  var sub = jwtSub(SESSION && SESSION.access_token);
  if (!sub) return 'none';
  try {
    var rows = await api('/rest/v1/user_roles?user_id=eq.' + encodeURIComponent(sub) + '&select=role');
    var role = rows && rows[0] && rows[0].role;
    if (role === 'admin' || role === 'customer') return role;
    return 'none';
  } catch (err) {
    var msg = String(err && err.message || '');
    if (/user_roles|schema cache|does not exist|Could not find the table|PGRST/i.test(msg)) return 'legacy-admin';
    throw err;
  }
}

function showAdminShell(email) {
  window.PORTAL_MODE = false;
  window.SESSION_ROLE = 'admin';
  var shown = email || localStorage.getItem('dockafi_email') || '';
  var nameEl = document.getElementById('user-email-display');
  var initEl = document.getElementById('user-initial');
  if (nameEl && shown) nameEl.textContent = shown.split('@')[0];
  if (initEl && shown) initEl.textContent = shown[0].toUpperCase();
  showScreen('screen-admin');
  nav('dashboard');
}

function logoSrc() {
  var img = document.querySelector('#screen-auth .auth-logo img');
  return img ? img.src : '';
}

function portalErrorBox(message) {
  if (!message) return '';
  return '<div class="auth-err" style="display:block;">' + esc(message) + '</div>';
}

function renderPortalLogin(message) {
  showPortalFrame();
  window.SESSION_ROLE = window.SESSION_ROLE === 'admin' ? 'admin' : null;
  var root = portalMount();
  root.innerHTML =
    '<div class="cust-page center"><div class="cust-login"><div class="cust-card">' +
      '<img class="cust-logo" alt="DockaFi" src="' + logoSrc() + '">' +
      '<div class="cust-kicker">DockaFi Customer Portal</div>' +
      '<div class="cust-title">Sign in to your account</div>' +
      portalErrorBox(message) +
      '<div class="form-group"><label class="form-label">Email</label>' +
        '<input class="form-control" id="portal-email" type="email" autocomplete="username"></div>' +
      '<div class="form-group"><label class="form-label">Password</label>' +
        '<input class="form-control" id="portal-pass" type="password" autocomplete="current-password"></div>' +
      '<button class="btn btn-primary btn-block" id="portal-signin" type="button">Sign in</button>' +
      '<a class="cust-forgot" href="#" id="portal-forgot">Forgot password?</a>' +
      '<a class="cust-quiet" href="/">Operator sign in</a>' +
    '</div></div></div>';
  document.getElementById('portal-signin').onclick = portalSignIn;
  document.getElementById('portal-forgot').onclick = function (e) { e.preventDefault(); renderForgot(); };
  document.getElementById('portal-pass').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') portalSignIn();
  });
}

function renderForgot(message) {
  showPortalFrame();
  portalMount().innerHTML =
    '<div class="cust-page center"><div class="cust-login"><div class="cust-card">' +
      '<div class="cust-kicker" style="text-align:left;margin-bottom:8px;">DockaFi Customer Portal</div>' +
      '<div class="cust-title">Reset your password</div>' +
      '<p class="cust-note" style="margin-top:0;">We will email a link to set a new password.</p>' +
      portalErrorBox(message) +
      '<div class="form-group"><label class="form-label">Email</label>' +
        '<input class="form-control" id="forgot-email" type="email" autocomplete="username"></div>' +
      '<button class="btn btn-primary btn-block" id="forgot-send" type="button">Send reset link</button>' +
      '<a class="cust-forgot" href="#" id="forgot-back">Back to sign in</a>' +
    '</div></div></div>';
  document.getElementById('forgot-back').onclick = function (e) { e.preventDefault(); renderPortalLogin(); };
  document.getElementById('forgot-send').onclick = sendForgot;
}

function renderSetPassword(message) {
  showPortalFrame();
  portalMount().innerHTML =
    '<div class="cust-page center"><div class="cust-login"><div class="cust-card">' +
      '<div class="cust-kicker" style="text-align:left;margin-bottom:8px;">DockaFi Customer Portal</div>' +
      '<div class="cust-title">Set your password</div>' +
      portalErrorBox(message) +
      '<div class="form-group"><label class="form-label">New password</label>' +
        '<input class="form-control" id="new-pass" type="password" autocomplete="new-password"></div>' +
      '<div class="form-group"><label class="form-label">Confirm password</label>' +
        '<input class="form-control" id="new-pass2" type="password" autocomplete="new-password"></div>' +
      '<button class="btn btn-primary btn-block" id="new-pass-save" type="button">Save password</button>' +
    '</div></div></div>';
  document.getElementById('new-pass-save').onclick = saveNewPassword;
}

async function portalFetch(path, opts) {
  var headers = { 'Content-Type': 'application/json' };
  if (opts && opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
  if (SESSION && SESSION.access_token) headers.Authorization = 'Bearer ' + SESSION.access_token;
  var res = await fetch(path, {
    method: (opts && opts.method) || 'GET',
    headers: headers,
    body: opts && opts.body ? opts.body : undefined
  });
  var text = await res.text();
  var data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    var err = new Error((data && data.error) || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function storeSession(data, email) {
  SESSION = data;
  localStorage.setItem('dockafi_session', JSON.stringify(data));
  if (email) localStorage.setItem('dockafi_email', email);
}

async function routeAfterAuth(email, fromPortal) {
  var role = await resolveRole();
  window.SESSION_ROLE = role === 'legacy-admin' ? 'admin' : role;
  if (role === 'customer') {
    await showCustomerAccount();
    return;
  }
  if (role === 'admin' || role === 'legacy-admin') {
    if (fromPortal) {
      renderPortalLogin('This is an operator login.');
      var card = portalMount().querySelector('.cust-card');
      if (card) {
        var link = document.createElement('button');
        link.className = 'btn btn-block';
        link.style.marginTop = '10px';
        link.textContent = 'Open the console';
        link.onclick = function () { showAdminShell(email); };
        card.appendChild(link);
      }
      return;
    }
    showAdminShell(email);
    return;
  }
  SESSION = null;
  localStorage.removeItem('dockafi_session');
  localStorage.removeItem('dockafi_email');
  var msg = 'This account does not have access.';
  if (fromPortal) renderPortalLogin(msg);
  else {
    showScreen('screen-auth');
    var errEl = document.getElementById('auth-err');
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  }
}

async function portalSignIn() {
  var email = document.getElementById('portal-email').value.trim();
  var pass = document.getElementById('portal-pass').value;
  var button = document.getElementById('portal-signin');
  if (!email || !pass) { renderPortalLogin('Email and password are required.'); return; }
  button.disabled = true;
  try {
    var data = await authApi('/token?grant_type=password', { email: email, password: pass });
    storeSession(data, email);
    await routeAfterAuth(email, true);
  } catch (err) {
    renderPortalLogin('Invalid email or password. Please try again.');
  }
}

async function sendForgot() {
  var email = document.getElementById('forgot-email').value.trim();
  var button = document.getElementById('forgot-send');
  button.disabled = true;
  try {
    await portalFetch('/api/portal-recover', {
      method: 'POST',
      body: JSON.stringify({ email: email })
    });
    renderPortalLogin('If that email has a portal login, a reset link is on its way.');
  } catch (err) {
    renderForgot(err.message);
  }
}

async function saveNewPassword() {
  var pass = document.getElementById('new-pass').value;
  var pass2 = document.getElementById('new-pass2').value;
  if (!PORTAL_RECOVERY || !PORTAL_RECOVERY.access_token) {
    renderPortalLogin('This reset link is missing or already used. Request a new one.');
    return;
  }
  if (pass.length < 8) { renderSetPassword('Use at least 8 characters.'); return; }
  if (pass !== pass2) { renderSetPassword('Those passwords do not match.'); return; }
  document.getElementById('new-pass-save').disabled = true;
  try {
    var res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      method: 'PUT',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + PORTAL_RECOVERY.access_token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: pass })
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.msg || data.error_description || data.message || 'Could not save the password');
    var email = (data.email || data.user && data.user.email || '').toLowerCase();
    storeSession({
      access_token: PORTAL_RECOVERY.access_token,
      refresh_token: PORTAL_RECOVERY.refresh_token,
      token_type: 'bearer'
    }, email);
    PORTAL_RECOVERY = null;
    await routeAfterAuth(email, true);
  } catch (err) {
    renderSetPassword(err.message);
  }
}

function statusOrb(coverage) {
  if (coverage === 'suspended') return '<div class="cust-orb suspended"><i class="ti ti-player-pause"></i></div>';
  if (coverage === 'cancelled' || coverage === 'canceled') return '<div class="cust-orb cancelled"><i class="ti ti-circle-x"></i></div>';
  return '<div class="cust-orb active"><i class="ti ti-circle-check"></i></div>';
}

function deviceCard(account, device) {
  var coverage = device.coverage || 'active';
  var word = coverageWord(coverage);
  var badgeClass = coverage === 'suspended' ? 'badge-suspended' : (coverage === 'cancelled' ? 'badge-cancel' : 'badge-active');
  var sub = coverage === 'suspended'
    ? 'Billing is paused until you reactivate this device.'
    : (coverage === 'cancelled'
      ? 'This service is canceled. Restarting later requires a new SIM card shipped to you. The current SIM cannot be reused.'
      : 'Your DockaFI service is on and billing as usual.');
  var deadline = coverage === 'suspended' && device.auto_cancel_on
    ? '<div class="cust-section"><div class="cust-eyebrow">Reactivate by</div>' +
      '<div class="cust-deadline">' + esc(longDate(device.auto_cancel_on)) + '</div>' +
      '<div class="cust-state-sub">If this device is not reactivated by that date, it will be canceled. We will send warning emails ahead of the cancellation. After the cancellation, a new SIM card must be shipped to restart service.</div></div>'
    : '';
  var actions = '';
  if (coverage === 'active') {
    actions = '<div class="cust-section"><div class="cust-eyebrow">Manage coverage</div><div class="cust-actions">' +
      '<button class="btn" type="button" data-act="suspend" data-device="' + esc(device.device_id) + '"><i class="ti ti-player-pause"></i> Suspend coverage</button>' +
      '<button class="btn btn-cancel-outline" type="button" data-act="cancel" data-device="' + esc(device.device_id) + '"><i class="ti ti-circle-x"></i> Cancel service</button>' +
      '</div></div>';
  } else if (coverage === 'suspended') {
    actions = '<div class="cust-actions" style="margin-top:18px;">' +
      '<button class="btn btn-go" type="button" data-act="reactivate" data-device="' + esc(device.device_id) + '"><i class="ti ti-player-play"></i> Reactivate coverage</button>' +
      '<button class="btn btn-cancel-outline" type="button" data-act="cancel" data-device="' + esc(device.device_id) + '"><i class="ti ti-circle-x"></i> Cancel service</button>' +
      '</div>';
  }
  return '<div class="cust-card" style="margin-bottom:16px;">' +
    '<div class="cust-status"><div class="cust-status-main">' + statusOrb(coverage) +
      '<div><div class="cust-eyebrow">Coverage status</div><div class="cust-state">' + esc(word) + '</div>' +
      '<div class="cust-state-sub">' + sub + '</div></div></div>' +
      '<span class="badge ' + badgeClass + '">' + esc(word) + '</span></div>' +
    deadline +
    '<div class="cust-grid">' +
      '<div><div class="cust-label">Name</div><div class="cust-value">' + esc((account.first_name || '') + ' ' + (account.last_name || '')) + '</div></div>' +
      '<div><div class="cust-label">Email</div><div class="cust-value">' + esc(account.email || '') + '</div></div>' +
      '<div><div class="cust-label">Device IMEI</div><div class="cust-value" style="font-family:var(--mono);">' + esc(device.imei || '—') + '</div></div>' +
      '<div><div class="cust-label">Data plan</div><div class="cust-value">' + esc(device.data_plan || '—') + '</div></div>' +
    '</div>' + actions + '</div>';
}

function renderAccount(account) {
  showPortalFrame();
  window.SESSION_ROLE = 'customer';
  var devices = (account && account.devices) || [];
  var cards = devices.length
    ? devices.map(function (device) { return deviceCard(account, device); }).join('')
    : '<div class="cust-card"><p class="cust-note" style="margin:0;">No device is linked to this login yet. Contact DockaFi and we will connect your unit.</p></div>';
  portalMount().innerHTML =
    '<div class="cust-page"><div class="cust-shell">' +
      '<div class="cust-top"><div><div class="cust-brand">DockaFI</div><div class="cust-brand-sub">DockaFi Customer Portal</div></div>' +
      '<button class="btn" type="button" id="portal-signout"><i class="ti ti-logout"></i> Sign out</button></div>' +
      cards +
      '<div id="cust-modal-host"></div>' +
    '</div></div>';
  document.getElementById('portal-signout').onclick = signOut;
  portalMount().querySelectorAll('[data-act]').forEach(function (button) {
    button.onclick = function () { openCoverageModal(account, button.getAttribute('data-act'), button.getAttribute('data-device')); };
  });
}

function openCoverageModal(account, action, deviceId) {
  var host = document.getElementById('cust-modal-host');
  if (!host) return;
  var device = ((account && account.devices) || []).filter(function (d) { return d.device_id === deviceId; })[0] || {};
  var deadline = longDate(device.auto_cancel_on || account.preview_auto_cancel_on);
  var html = '';
  if (action === 'suspend') {
    html = '<div class="cust-modal-back"><div class="cust-modal"><h2>Suspend your coverage?</h2>' +
      '<div class="cust-callout warn"><strong><i class="ti ti-alert-triangle"></i> Please read this first</strong>' +
      'You will not be billed while the account is suspended, until you are ready to use the device again. You must reactivate within 6 months or the device will be canceled. We will send warning emails ahead of that cancellation.</div>' +
      '<div class="cust-note">If you suspend today</div>' +
      '<div class="cust-value" style="margin-top:6px;">Reactivate by ' + esc(deadline) + ', or coverage will be canceled.</div>' +
      '<div class="cust-actions"><button class="btn" type="button" id="modal-dismiss">Keep coverage active</button>' +
      '<button class="btn btn-primary" type="button" id="modal-confirm">Suspend coverage</button></div></div></div>';
  } else if (action === 'cancel') {
    html = '<div class="cust-modal-back"><div class="cust-modal"><h2>Cancel this service?</h2>' +
      '<div class="cust-callout danger"><strong><i class="ti ti-circle-x"></i> This cannot be restarted on the same SIM</strong>' +
      'If you cancel, restarting service later will require a new SIM card shipped to you. The current SIM cannot be reused to turn this account back on.</div>' +
      '<p class="cust-note">If you only need a break, choose Suspend instead. Billing stops during a suspension, and you can reactivate within 6 months without a new SIM.</p>' +
      '<div class="cust-actions"><button class="btn" type="button" id="modal-dismiss">Keep my service</button>' +
      '<button class="btn btn-cancel-solid" type="button" id="modal-confirm">Cancel service</button></div></div></div>';
  } else {
    runCoverageAction(action, deviceId);
    return;
  }
  host.innerHTML = html;
  document.getElementById('modal-dismiss').onclick = function () { host.innerHTML = ''; };
  document.getElementById('modal-confirm').onclick = function () { runCoverageAction(action, deviceId, document.getElementById('modal-confirm')); };
}

async function runCoverageAction(action, deviceId, button) {
  if (button) button.disabled = true;
  try {
    await portalFetch('/api/portal-action', {
      method: 'POST',
      body: JSON.stringify({ action: action, device_id: deviceId })
    });
    await showCustomerAccount();
    toast(action === 'suspend' ? 'Coverage suspended' : action === 'reactivate' ? 'Coverage reactivated' : 'Service canceled', 'success');
  } catch (err) {
    toast(err.message, 'error');
    if (button) button.disabled = false;
  }
}

async function showCustomerAccount() {
  showPortalFrame();
  window.SESSION_ROLE = 'customer';
  portalMount().innerHTML = '<div class="cust-page center"><div class="cust-state-sub">Loading your coverage…</div></div>';
  try {
    var data = await portalFetch('/api/portal-account');
    renderAccount(data.account || {});
  } catch (err) {
    if (err.status === 401) { renderPortalLogin('Sign in again to see your coverage.'); return; }
    renderPortalLogin(err.message);
  }
}

async function bootDockafi() {
  ensureNewCustomerModal();
  var hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  var type = hash.get('type');
  if (hash.get('error_description') || hash.get('error')) {
    history.replaceState(null, '', '/?portal=1');
    renderPortalLogin((hash.get('error_description') || hash.get('error') || 'That link could not be used.').replace(/\+/g, ' '));
    return;
  }
  if (hash.get('access_token') && (type === 'recovery' || type === 'invite' || type === 'signup' || type === 'magiclink')) {
    PORTAL_RECOVERY = {
      access_token: hash.get('access_token'),
      refresh_token: hash.get('refresh_token') || ''
    };
    history.replaceState(null, '', '/?portal=1');
    renderSetPassword();
    return;
  }
  var params = new URLSearchParams(location.search);
  var portal = params.get('portal') === '1' || location.hash === '#portal';
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('dockafi_session') || 'null'); } catch (e) { saved = null; }
  if (saved && saved.access_token) {
    SESSION = saved;
    if (!(await ensureSession())) saved = null;
  }
  if (saved && SESSION) {
    try {
      var role = await resolveRole();
      window.SESSION_ROLE = role === 'legacy-admin' ? 'admin' : role;
      if (role === 'customer') { await showCustomerAccount(); return; }
      if ((role === 'admin' || role === 'legacy-admin') && !portal) {
        showAdminShell(localStorage.getItem('dockafi_email') || '');
        return;
      }
    } catch (err) {
      localStorage.removeItem('dockafi_session');
      SESSION = null;
    }
  }
  if (portal) renderPortalLogin();
  else showScreen('screen-auth');
}

function portalAccessBadge(user) {
  if (!user) return '';
  if (user.portal_activated_at) return '<span class="badge badge-active">Ready</span>';
  if (user.portal_invited_at || user.auth_user_id) return '<span class="badge invite-sent">Invite sent</span>';
  return '<span class="badge badge-inactive">Not invited</span>';
}

function currentCoverage(user) {
  var links = (user && user.device_enduser) || [];
  var current = links.filter(function (l) { return l.status === 'active' || l.status === 'suspended'; });
  var pool = current.length ? current : links;
  var link = pool[0];
  if (!link) return { status: '', imei: '' };
  var subs = link.subscriptions || [];
  var sub = subs.filter(function (s) { return s.status === 'active' || s.status === 'suspended'; })[0] || subs[0];
  return {
    status: (sub && sub.status) || link.status || '',
    imei: (link.devices && link.devices.imei) || ''
  };
}

window.loadEndUsers = async function () {
  var tbody = document.getElementById('endusers-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7"><div class="loading"><div class="spinner"></div>Loading...</div></td></tr>';
  var showDeleted = document.getElementById('show-deleted-endusers') && document.getElementById('show-deleted-endusers').checked;
  var filter = showDeleted ? '&status=eq.cancelled' : '&status=in.(active,suspended)';
  var extended = '/rest/v1/end_users?select=id,first_name,last_name,email,phone,status,auth_user_id,portal_invited_at,portal_activated_at,device_enduser(status,devices(imei),subscriptions(status,plan_name))&order=created_at.desc' + filter;
  var legacy = '/rest/v1/end_users?select=*,organizations(name),device_enduser(status,devices(serial_number))&order=created_at.desc' + filter;
  try {
    var rows;
    var modern = true;
    try {
      rows = await api(extended);
    } catch (err) {
      var msg = String(err.message || '');
      if (!/auth_user_id|portal_invited|portal_activated|schema cache|column/i.test(msg)) throw err;
      modern = false;
      rows = await api(legacy);
    }
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><i class="ti ti-users"></i>No customers yet</div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (user) {
      var name = esc((user.first_name || '') + ' ' + (user.last_name || ''));
      if (!modern) {
        var serials = (user.device_enduser || []).filter(function (l) { return l.status === 'active'; }).map(function (l) { return l.devices && l.devices.serial_number; }).filter(Boolean);
        return '<tr><td><strong style="color:var(--text);">' + name + '</strong></td><td>' + esc(user.email) + '</td><td>' + esc(user.phone || '—') + '</td><td class="mono">' + (serials[0] ? esc(serials[0]) : '—') + '</td><td>' + statusBadge(user.status) + '</td><td>—</td><td><button class="btn btn-sm" type="button" onclick="openEditEndUser(\'' + user.id + '\')">Edit</button></td></tr>';
      }
      var cov = currentCoverage(user);
      var imeis = (user.device_enduser || []).map(function (l) { return l.devices && l.devices.imei; }).filter(Boolean);
      var imei = cov.imei || imeis[0] || '';
      var restore = user.status === 'cancelled'
        ? '<button class="btn btn-success btn-sm" type="button" onclick="restoreEndUser(\'' + user.id + '\')">Restore</button>'
        : '<button class="btn btn-sm" type="button" onclick="resendPortalEmail(\'' + user.id + '\')"><i class="ti ti-mail"></i> Resend password email</button> <button class="btn btn-sm" type="button" onclick="openEditEndUser(\'' + user.id + '\')">Edit</button>';
      return '<tr><td><strong style="color:var(--text);">' + name + '</strong></td><td>' + esc(user.email) + '</td><td style="white-space:nowrap;">' + esc(user.phone || '—') + '</td><td class="mono">' + (imei ? esc(imei) : '—') + '</td><td>' + (cov.status ? '<span class="badge ' + (cov.status === 'active' ? 'badge-active' : cov.status === 'suspended' ? 'badge-suspended' : 'badge-cancel') + '">' + coverageWord(cov.status) + '</span>' : '—') + '</td><td>' + portalAccessBadge(user) + '</td><td style="white-space:nowrap;">' + restore + '</td></tr>';
    }).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--red);padding:16px;">Error: ' + esc(err.message) + '</td></tr>';
  }
};

function ensureNewCustomerModal() {
  if (document.getElementById('modal-new-customer')) return;
  var wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.id = 'modal-new-customer';
  wrap.innerHTML =
    '<div class="modal"><div class="modal-title">New customer account</div>' +
    '<div class="cust-banner">Saving this account will email the customer a link to set their portal password. They will sign in at the customer portal with that email.</div>' +
    '<div id="nc-error" class="auth-err"></div>' +
    '<div class="form-grid"><div class="form-group"><label class="form-label">First name</label><input class="form-control" id="nc-first"></div>' +
    '<div class="form-group"><label class="form-label">Last name</label><input class="form-control" id="nc-last"></div>' +
    '<div class="form-group"><label class="form-label">Email address</label><input class="form-control" id="nc-email" type="email"></div>' +
    '<div class="form-group"><label class="form-label">Phone number</label><input class="form-control" id="nc-phone" placeholder="(optional)"></div>' +
    '<div class="form-group" style="grid-column:1/-1;"><label class="form-label">IMEI number</label><input class="form-control" id="nc-imei" inputmode="numeric">' +
    '<div class="form-note">Must match a device already in the registry.</div></div></div>' +
    '<div id="nc-link" class="cust-linkbox" style="display:none;"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">' +
    '<button class="btn" type="button" onclick="closeModal(\'modal-new-customer\')">Cancel</button>' +
    '<button class="btn btn-primary" id="nc-save" type="button" onclick="submitNewCustomer()"><i class="ti ti-mail"></i> Create account and send invite</button>' +
    '</div></div>';
  document.body.appendChild(wrap);
}

function openNewCustomer() {
  ensureNewCustomerModal();
  ['nc-first', 'nc-last', 'nc-email', 'nc-phone', 'nc-imei'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var err = document.getElementById('nc-error');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  var link = document.getElementById('nc-link');
  if (link) { link.style.display = 'none'; link.textContent = ''; }
  openModal('modal-new-customer');
}

async function submitNewCustomer() {
  var button = document.getElementById('nc-save');
  var err = document.getElementById('nc-error');
  var link = document.getElementById('nc-link');
  err.style.display = 'none';
  link.style.display = 'none';
  button.disabled = true;
  try {
    var data = await portalFetch('/api/customer-admin', {
      method: 'POST',
      body: JSON.stringify({
        action: 'invite',
        first_name: document.getElementById('nc-first').value.trim(),
        last_name: document.getElementById('nc-last').value.trim(),
        email: document.getElementById('nc-email').value.trim(),
        phone: document.getElementById('nc-phone').value.trim(),
        imei: document.getElementById('nc-imei').value.trim()
      })
    });
    if (data.setup_link) {
      link.style.display = 'block';
      link.textContent = data.setup_link;
      err.style.display = 'block';
      err.textContent = data.reason || 'Email is not configured, so the setup link is shown here for the operator only.';
    } else {
      closeModal('modal-new-customer');
      toast('Invite email sent', 'success');
    }
    if (typeof loadEndUsers === 'function') loadEndUsers();
  } catch (e) {
    err.style.display = 'block';
    err.textContent = e.message;
  }
  button.disabled = false;
}

async function resendPortalEmail(id) {
  try {
    var data = await portalFetch('/api/customer-admin', {
      method: 'POST',
      body: JSON.stringify({ action: 'resend', end_user_id: id })
    });
    if (data.setup_link) {
      window.prompt('Email is not configured. Copy this one-time setup link:', data.setup_link);
    } else {
      toast('Password email sent', 'success');
    }
    loadEndUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

window.bootDockafi = bootDockafi;
window.openNewCustomer = openNewCustomer;
window.submitNewCustomer = submitNewCustomer;
window.resendPortalEmail = resendPortalEmail;
window.routeAfterAuth = routeAfterAuth;
window.renderPortalLogin = renderPortalLogin;
