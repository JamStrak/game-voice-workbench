/* Creator Hub browser lifecycle bridge v1. Vendored by each tool, no Hub URL dependency. */
(() => {
  'use strict';
  if (window.__creatorHubBridge) return;
  const rawFetch = window.fetch.bind(window);
  const rawOpen = XMLHttpRequest.prototype.open;
  const rawSend = XMLHttpRequest.prototype.send;
  const rawRAF = window.requestAnimationFrame.bind(window);
  const rawCancelRAF = window.cancelAnimationFrame.bind(window);
  const sessionId = crypto.randomUUID();
  const readonlyPosts = new Set(window.__CREATOR_HUB_READONLY_POSTS__ || []);
  let token, instanceId, enabled = false, bootComplete = false, frozen = false, pending = false, dock, statusText, actionButton, timer;
  let frameCounter = 0;
  let releaseInFlight = null;
  let remoteActivity = false;
  const frames = new Map();
  const inertBefore = new Map();
  const animations = new Set();
  const lifecyclePath = url => url.origin === location.origin && url.pathname.startsWith('/api/hub/');
  const remoteHttp = url => url.origin !== location.origin && ['http:', 'https:'].includes(url.protocol);
  const targetUrl = input => new URL(input instanceof Request ? input.url : String(input), location.href);

  async function lifecycle(action, extra = {}, keepalive = false) {
    const response = await rawFetch('/api/hub/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Control': token },
      body: JSON.stringify({ sessionId, action, instanceId, ...extra }), keepalive,
      signal: keepalive ? undefined : AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error('服务尚未允许此操作，请稍后重试。');
    return response.json();
  }
  function scheduleFrame(id, frame) {
    frame.handle = rawRAF(time => {
      frame.handle = null;
      if (frozen) return;
      frames.delete(id);
      frame.callback(time);
    });
  }
  window.requestAnimationFrame = callback => {
    const id = ++frameCounter, frame = { callback, handle: null };
    frames.set(id, frame);
    if (!frozen) scheduleFrame(id, frame);
    return id;
  };
  window.cancelAnimationFrame = id => {
    const frame = frames.get(id);
    if (frame?.handle != null) rawCancelRAF(frame.handle);
    frames.delete(id);
  };
  function protectChild(node) {
    if (node === dock || !(node instanceof HTMLElement) || inertBefore.has(node)) return;
    inertBefore.set(node, node.inert);
    node.inert = true;
  }
  const observer = new MutationObserver(records => {
    if (frozen) for (const record of records) for (const node of record.addedNodes) protectChild(node);
  });
  function freeze(value) {
    frozen = value;
    if (value) {
      for (const node of document.body.children) protectChild(node);
      document.querySelectorAll('audio,video').forEach(media => media.pause());
      for (const animation of document.getAnimations()) if (animation.playState === 'running') { animations.add(animation); animation.pause(); }
      observer.observe(document.body, { childList: true });
    } else {
      observer.disconnect();
      for (const [node, wasInert] of inertBefore) node.inert = wasInert;
      inertBefore.clear();
      for (const animation of animations) { try { animation.play(); } catch {} }
      animations.clear();
      for (const [id, frame] of frames) if (frame.handle == null) scheduleFrame(id, frame);
    }
    draw();
  }
  async function restore(reason, reload = false) {
    // Release and resume must reach the server in order. A delayed save arriving
    // during release cannot overtake it and leave an editable page marked clean.
    if (releaseInFlight) { try { await releaseInFlight; } catch {} }
    await lifecycle('resume');
    freeze(false);
    if (reason) statusText.textContent = reason;
    if (reload) location.reload();
  }
  async function protectRemoteActivity() {
    remoteActivity = true;
    if (frozen) {
      try { await restore('检测到其他地址的服务连接，已恢复保护；本页请继续手动使用。'); }
      catch (error) { draw(); statusText.textContent = '检测到其他地址的服务请求，但尚未恢复当前页面的保护。请恢复连接后再试。'; throw error; }
    }
    draw();
  }
  async function gate(input, init) {
    await ready;
    const url = targetUrl(input);
    if (!enabled || lifecyclePath(url)) return init;
    if (url.origin !== location.origin) { if (remoteHttp(url)) await protectRemoteActivity(); return init; }
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (frozen) {
      if (method === 'GET' || method === 'HEAD' || readonlyPosts.has(url.pathname)) {
        throw new DOMException('页面已交还Hub，轮询与预览已暂停。恢复使用后重新载入。', 'AbortError');
      }
      // A delayed save/write is evidence that the page was not finished: revoke
      // release before sending it rather than dropping the user's pending save.
      await restore('检测到新的保存或操作，已撤销交还。请完成后再次交还。');
    }
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-Hub-Session', sessionId);
    return { ...init, headers };
  }
  window.fetch = async (input, init) => rawFetch(input, await gate(input, init));
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__hubRequest = { method, url };
    this.__hubAsync = rest[0] !== false;
    return rawOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (!bootComplete && this.__hubAsync !== false) { ready.then(() => this.send(body)); return; }
    const request = this.__hubRequest;
    if (!request || !enabled) return rawSend.call(this, body);
    const url = targetUrl(request.url);
    if (lifecyclePath(url)) return rawSend.call(this, body);
    if (url.origin !== location.origin) {
      if (!remoteHttp(url)) return rawSend.call(this, body);
      if (!frozen) { remoteActivity = true; draw(); return rawSend.call(this, body); }
      protectRemoteActivity().then(() => rawSend.call(this, body)).catch(() => this.abort());
      return;
    }
    if (frozen) {
      if (['GET', 'HEAD'].includes(String(request.method).toUpperCase()) || readonlyPosts.has(url.pathname)) {
        this.abort(); return;
      }
      restore('检测到新的保存或操作，已撤销交还。').then(() => {
        this.setRequestHeader('X-Hub-Session', sessionId); rawSend.call(this, body);
      }).catch(() => this.abort());
      return;
    }
    this.setRequestHeader('X-Hub-Session', sessionId);
    return rawSend.call(this, body);
  };
  function draw() {
    if (!dock) return;
    dock.classList.toggle('hub-released', frozen);
    actionButton.disabled = pending || (remoteActivity && !frozen);
    actionButton.textContent = pending ? '正在确认…' : frozen ? '恢复使用' : '交还 Hub';
    statusText.textContent = frozen ? '已交还：本页编辑和预览已暂停。Hub会等待后台任务完成。'
      : remoteActivity ? '本页使用了其他地址的服务，Hub无法核验其任务；请继续手动使用，本页不再允许交还。'
      : '正在保护本页。保存完成后可交还 Hub，允许回收后台资源。';
  }
  function confirmRelease() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.id = 'creator-hub-confirmation';
      dialog.setAttribute('aria-labelledby', 'creator-hub-confirmation-title');
      dialog.setAttribute('aria-describedby', 'creator-hub-confirmation-description');
      const title = document.createElement('h2'); title.id = 'creator-hub-confirmation-title'; title.textContent = '交还给 Hub？';
      const description = document.createElement('p'); description.id = 'creator-hub-confirmation-description';
      description.textContent = '请先保存编辑，并等待保存完成。交还后本页会暂停编辑和预览，Hub可在后台任务结束后关闭服务。未保存内容可能无法恢复。';
      const actions = document.createElement('div'); actions.className = 'creator-hub-confirmation-actions';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '返回编辑';
      const accept = document.createElement('button'); accept.type = 'button'; accept.textContent = '已保存，交还 Hub'; accept.className = 'creator-hub-confirmation-accept';
      let finished = false;
      const finish = accepted => {
        if (finished) return; finished = true;
        if (dialog.open) dialog.close(); dialog.remove(); resolve(accepted);
      };
      cancel.addEventListener('click', () => finish(false)); accept.addEventListener('click', () => finish(true));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('close', () => finish(false));
      actions.append(cancel, accept); dialog.append(title, description, actions); document.body.append(dialog);
      try { dialog.showModal(); cancel.focus(); }
      catch { finish(false); statusText.textContent = '当前浏览器无法显示交还确认，请更新浏览器后重试。'; }
    });
  }
  function mount() {
    dock = document.createElement('div'); dock.id = 'creator-hub-lifecycle';
    const style = document.createElement('style');
    style.textContent = '#creator-hub-lifecycle{position:fixed;z-index:2147483647;right:14px;bottom:14px;display:flex;align-items:center;gap:10px;max-width:min(580px,calc(100vw - 28px));padding:10px 12px;border:1px solid #97a894;border-radius:12px;background:#f4f4ecdF;backdrop-filter:blur(14px);box-shadow:0 4px 22px #162c2420;color:#254237;font:12px/1.5 system-ui,sans-serif}#creator-hub-lifecycle button{flex-shrink:0;border:0;border-radius:7px;background:#254237;color:#fff;padding:7px 11px;cursor:pointer;font:inherit}#creator-hub-lifecycle button:disabled{opacity:.5;cursor:wait}#creator-hub-lifecycle.hub-released{inset:0;margin:auto;width:min(520px,calc(100vw - 40px));height:fit-content;padding:22px;background:#f4f4ec;box-shadow:0 0 0 100vmax #15251bb3;font-size:14px}';
    style.textContent += '#creator-hub-confirmation{width:min(460px,calc(100vw - 48px));box-sizing:border-box;padding:24px;border:1px solid #97a894;border-radius:16px;background:#f4f4ec;color:#254237;box-shadow:0 16px 70px #15251b40;font:14px/1.6 system-ui,sans-serif}#creator-hub-confirmation::backdrop{background:#15251b88}#creator-hub-confirmation h2{margin:0 0 12px;font-size:20px;line-height:1.3}#creator-hub-confirmation p{margin:0 0 22px}#creator-hub-confirmation .creator-hub-confirmation-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:10px}#creator-hub-confirmation button{border:1px solid #97a894;border-radius:8px;padding:9px 13px;background:transparent;color:#254237;cursor:pointer;font:inherit}#creator-hub-confirmation button.creator-hub-confirmation-accept{background:#254237;border-color:#254237;color:#fff}#creator-hub-confirmation button:focus-visible{outline:3px solid #ad734d;outline-offset:3px}';
    statusText = document.createElement('span'); statusText.setAttribute('role', 'status');
    actionButton = document.createElement('button'); actionButton.type = 'button';
    dock.append(style, statusText, actionButton); document.body.append(dock); draw();
    actionButton.addEventListener('click', async () => {
      if (pending) return;
      if (remoteActivity && !frozen) { draw(); return; }
      if (frozen) {
        pending = true; draw();
        try { await restore('已恢复使用；自动关闭会等待您再次交还。'); }
        catch { statusText.textContent = '工具已关闭或正在释放。请从 Hub 重新打开；保存的作品仍在原处。'; }
        finally { pending = false; actionButton.disabled = remoteActivity && !frozen; actionButton.textContent = frozen ? '恢复使用' : '交还 Hub'; }
        return;
      }
      pending = true; draw();
      if (!await confirmRelease() || remoteActivity) { pending = false; draw(); return; }
      freeze(true);
      try { releaseInFlight = lifecycle('release'); await releaseInFlight; }
      catch {
        // A lost response may still mean the server accepted release. Never
        // unfreeze until a resume is acknowledged by that same instance.
        try { await lifecycle('resume'); freeze(false); statusText.textContent = '交还未成功，已恢复保护，请稍后重试。'; }
        catch { statusText.textContent = '暂未确认后台状态，页面保持暂停；请恢复连接后点击「恢复使用」。'; }
      }
      finally { releaseInFlight = null; pending = false; actionButton.disabled = remoteActivity && !frozen; actionButton.textContent = frozen ? '恢复使用' : '交还 Hub'; }
    });
  }
  async function heartbeat() {
    try { await lifecycle('heartbeat'); }
    catch { if (statusText) statusText.textContent = frozen ? '后台暂不可达；请从 Hub 查看或重新打开工具。' : 'Hub状态连接暂不可达，本页不会被当作可自动关闭。'; }
    timer = setTimeout(heartbeat, 15000);
  }
  const ready = (async () => {
    try {
      const response = await rawFetch('/api/hub/status', { signal: AbortSignal.timeout(1800) });
      if (!response.ok) return;
      const runtime = await response.json();
      if (runtime.protocolVersion !== 1 || typeof runtime.controlToken !== 'string') return;
      token = runtime.controlToken; instanceId = runtime.instanceId;
      await lifecycle('heartbeat'); enabled = true;
      // Do not await DOMContentLoaded here: module startup can itself await fetch.
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
      else mount();
      timer = setTimeout(heartbeat, 15000);
      window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        clearTimeout(timer); lifecycle('close', {}, true).catch(() => {});
      });
      window.addEventListener('pageshow', event => { if (event.persisted) { clearTimeout(timer); heartbeat(); } });
    } catch { /* Older services keep their original working behavior. */ }
    finally { bootComplete = true; }
  })();
  window.__creatorHubBridge = { version: 1 };
})();
