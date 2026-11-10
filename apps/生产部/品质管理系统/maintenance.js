/* 维护状态仅由同源服务决定；保留当前表单与草稿，恢复后由用户核对并刷新。 */
(function () {
  'use strict';
  var activated = false, inFlight = false, checking = true;
  var base = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');
  var guard = window.__QC_MAINTENANCE = { blocked: false, activate: activate };
  function render(title, message, refresh, retry) {
    var overlay = document.getElementById('qcMaintenance');
    if (!overlay) return;
    overlay.hidden = !guard.blocked && !checking;
    document.getElementById('qcMaintenanceTitle').textContent = title;
    document.getElementById('qcMaintenanceMessage').textContent = message;
    document.getElementById('qcMaintenanceRefresh').hidden = !refresh;
    document.getElementById('qcMaintenanceRetry').hidden = !retry;
    ['appWrapper', 'loginScreen'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.inert = guard.blocked || checking;
    });
  }
  function activate() {
    activated = true; checking = false; guard.blocked = true;
    if (typeof window.__QC_OCR_CANCEL === 'function') window.__QC_OCR_CANCEL();
    render('系统修复中', '请稍后再试。', false);
  }
  function check() {
    if (inFlight) return;
    inFlight = true;
    var retry = document.getElementById('qcMaintenanceRetry');
    if (retry) retry.disabled = true;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 5000);
    fetch(base + '/api/maintenance', { credentials: 'same-origin', cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (response) {
        // 网关切换容器时返回维护 HTML；不要把它当作连接故障或解析 JSON。
        if (response.status === 503 && response.headers &&
            (response.headers.get('X-QC-Maintenance') === '1' || response.headers.get('Retry-After'))) return { enabled: true };
        if (!response.ok) throw new Error('status');
        return response.json();
      })
      .then(function (state) {
        if (!state || typeof state.enabled !== 'boolean') throw new Error('invalid status');
        checking = false;
        if (state.enabled) activate();
        else if (activated) { guard.blocked = true; render('修复已完成', '请核对未保存内容后刷新。', true); }
        else { guard.blocked = false; render('', '', false); }
      })
      .catch(function () { checking = false; guard.blocked = true; render('暂时无法连接系统', '请稍后重试。', false, true); })
      .finally(function () { clearTimeout(timer); inFlight = false; if (retry) retry.disabled = false; });
  }
  ['click', 'submit', 'keydown'].forEach(function (event) {
    document.addEventListener(event, function (e) {
      var overlay = document.getElementById('qcMaintenance');
      if ((guard.blocked || checking) && overlay && !overlay.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  });
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('qcMaintenanceRefresh').onclick = function () { location.reload(); };
    document.getElementById('qcMaintenanceRetry').onclick = function () { check(); };
    if (guard.blocked || checking) render(activated ? '系统修复中' : '正在检查系统状态', '请稍候。', false);
    check();
  });
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  setInterval(check, 5000);
  check();
})();
