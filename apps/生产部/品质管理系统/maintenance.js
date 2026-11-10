/* 维护状态仅由同源服务决定；保留当前表单与草稿，恢复后由用户核对并刷新。 */
(function () {
  'use strict';
  var activated = false, inFlight = false, checking = true, healthy = false, pending = null;
  var base = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');
  var guard = window.__QC_MAINTENANCE = { blocked: false, activate: activate };
  function blocksUi() {
    // 已正常打开后的断线只暂停提交；初次未确认状态或明确维护才遮住页面。
    // 旧 HTML 没有小提示时仍保留完整保护，避免无提示地暂停保存。
    return checking || guard.blocked && (activated || !healthy || !document.getElementById('qcConnectionNotice'));
  }
  function render(title, message, refresh, retry) {
    var overlay = document.getElementById('qcMaintenance');
    if (!overlay) return;
    var blocked = blocksUi();
    overlay.hidden = !blocked;
    var notice = document.getElementById('qcConnectionNotice');
    if (notice) notice.hidden = blocked || !guard.blocked;
    document.getElementById('qcMaintenanceTitle').textContent = title;
    document.getElementById('qcMaintenanceMessage').textContent = message;
    document.getElementById('qcMaintenanceRefresh').hidden = !refresh;
    var retryButton = document.getElementById('qcMaintenanceRetry');
    if (retryButton) retryButton.hidden = !retry;
    ['appWrapper', 'loginScreen'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.inert = blocked;
    });
  }
  function activate() {
    activated = true; checking = false; guard.blocked = true;
    guard.message = '系统修复中，暂时无法操作';
    if (typeof window.__QC_OCR_CANCEL === 'function') window.__QC_OCR_CANCEL();
    render('系统修复中', '请稍后再试。', false);
  }
  function check() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    var retry = document.getElementById('qcMaintenanceRetry');
    var connectionRetry = document.getElementById('qcConnectionRetry');
    if (retry) retry.disabled = true;
    if (connectionRetry) connectionRetry.disabled = true;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var operation = { controller: controller, suspended: false, reason: 'network', startedAt: Date.now() };
    pending = operation;
    var timer = operation.timer = setTimeout(function () { operation.reason = 'timeout'; if (controller) controller.abort(); }, 10000);
    fetch(base + '/api/maintenance', { credentials: 'same-origin', cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (response) {
        // 网关切换容器时返回维护 HTML；不要把它当作连接故障或解析 JSON。
        if (response.status === 503 && response.headers &&
            (response.headers.get('X-QC-Maintenance') === '1' || response.headers.get('Retry-After'))) return { enabled: true };
        if (!response.ok) { operation.reason = 'http-' + response.status; throw new Error('status'); }
        return response.json().catch(function (error) { operation.reason = 'invalid-response'; throw error; });
      })
      .then(function (state) {
        // 响应正文可能在 abort 后才完成；主动取消的成功结果也必须丢弃。
        if (operation.suspended) return;
        if (!state || typeof state.enabled !== 'boolean') { operation.reason = 'invalid-status'; throw new Error('invalid status'); }
        checking = false;
        if (state.enabled) activate();
        else if (activated) { guard.blocked = true; render('修复已完成', '请核对未保存内容后刷新。', true); }
        else { healthy = true; guard.blocked = false; guard.message = ''; render('', '', false); }
      })
      .catch(function () {
        // 切到后台主动取消的检查不代表断线，不能改变当前保护或表单状态。
        if (operation.suspended) return;
        if (typeof console !== 'undefined' && console.warn) console.warn('[QMS status]', operation.reason, base + '/api/maintenance', Date.now() - operation.startedAt + 'ms');
        checking = false; guard.blocked = true;
        if (activated) { render('系统修复中', '请稍后再试。', false, true); return; }
        guard.message = '连接中断，保存已暂停，请重试';
        render('暂时无法连接系统', '请稍后重试。', false, true);
      })
      .finally(function () {
        clearTimeout(timer); inFlight = false;
        if (pending === operation) pending = null;
        if (retry) retry.disabled = false;
        if (connectionRetry) connectionRetry.disabled = false;
        if (operation.suspended && !document.hidden) check();
      });
  }
  ['click', 'submit', 'keydown'].forEach(function (event) {
    document.addEventListener(event, function (e) {
      var overlay = document.getElementById('qcMaintenance');
      if (blocksUi() && overlay && !overlay.contains(e.target)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (event === 'keydown' && e.key === 'Tab') {
          var button = ['qcMaintenanceRefresh', 'qcMaintenanceRetry'].map(function (id) {
            return document.getElementById(id);
          }).find(function (el) { return el && !el.hidden && !el.disabled; });
          if (button) button.focus();
        }
      }
    }, true);
  });
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('qcMaintenanceRefresh').onclick = function () { location.reload(); };
    var retryButton = document.getElementById('qcMaintenanceRetry');
    if (retryButton) retryButton.onclick = function () { check(); };
    var connectionRetry = document.getElementById('qcConnectionRetry');
    if (connectionRetry) connectionRetry.onclick = function () { check(); };
    if (guard.blocked || checking) render(activated ? '系统修复中' : '正在检查系统状态', '请稍候。', false);
    check();
  });
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { check(); return; }
    if (pending) {
      pending.suspended = true; clearTimeout(pending.timer);
      if (pending.controller) pending.controller.abort();
    }
  });
  setInterval(check, 5000);
  check();
})();
