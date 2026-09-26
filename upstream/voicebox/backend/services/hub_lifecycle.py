"""Hub protocol v1. Local, explicit page release; never infer safety from CPU/age.

Kept as a standalone module so this tool remains distributable without the Hub.
The ASGI wrapper holds request activity through streaming AND background work.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.parse import urlsplit


class LifecycleError(Exception):
    def __init__(self, message, status=409):
        self.message, self.status = message, status


class HubLifecycle:
    def __init__(self, tool_id, root, jobs, *, bridge_path=None, instance_id=None,
                 media_paths=(), health_paths=(), static_paths=(), model_note='',
                 readonly_posts=(), clock=time.time):
        self.tool_id, self.root, self.jobs = tool_id, str(Path(root).resolve()), jobs
        self.instance_id = instance_id or secrets.token_hex(16)
        self.token = secrets.token_urlsafe(32)
        self.bridge_path = Path(bridge_path or Path(__file__).with_name('hub_bridge.js'))
        self.media_paths = [re.compile(pattern) for pattern in media_paths]
        self.health_paths = set(health_paths)
        self.static_paths = set(static_paths)
        self.model_note = model_note
        self.readonly_posts = list(readonly_posts)
        self.clock, self.lock = clock, threading.RLock()
        self.sessions, self.ever_observed, self.untracked = {}, False, False
        self.active_requests, self.workers, self.worker_unknown = 0, set(), False
        self.revision, self.last_activity = 1, self.now()
        self.prepared, self.committed, self.shutdown = None, False, None
        self._signature = None

    def now(self):
        return int(self.clock() * 1000)

    def touch(self):
        self.revision += 1
        self.last_activity = self.now()

    def expire(self):
        if self.prepared and not self.committed and self.now() >= self.prepared['expiresAt']:
            self.prepared = None
            self.touch()

    def snapshot(self):
        with self.lock:
            self.expire()
            active = released = lost = 0
            for session in self.sessions.values():
                if session['closed'] or self.now() - session['seen'] > 60000:
                    lost += 1
                elif session['released']:
                    released += 1
                else:
                    active += 1
            try:
                state = self.jobs()
                running, queued = state['activeJobs'], state['queuedJobs']
                if type(running) is not int or type(queued) is not int or min(running, queued) < 0:
                    raise ValueError('Invalid task snapshot')
                task_unknown = bool(state.get('unknown')) or self.worker_unknown
            except Exception:
                running, queued, task_unknown = None, None, True
            busy = bool(running or queued or self.active_requests or self.workers)
            task_state = 'unknown' if task_unknown else 'busy' if busy else 'idle'
            save_state = 'unknown' if lost or self.untracked or not self.ever_observed else 'protected' if active else 'clean'
            signature = (active, released, lost, self.untracked, self.ever_observed,
                         running, queued, self.active_requests, len(self.workers), task_unknown)
            if self._signature != signature:
                self._signature = signature
                self.touch()
            reasons = []
            if task_unknown:
                reasons.append('后台任务或模型进程状态未知，保留运行。')
            elif busy:
                reasons.append('后台任务、队列或请求仍在执行。')
            if not self.ever_observed:
                reasons.append('尚未观察到已接入页面，请打开工具并保存后交还 Hub。')
            if self.untracked:
                reasons.append('检测到未登记客户端；本实例不自动关闭，请保存后手动停止并重新打开。')
            if lost:
                reasons.append('页面失联或未经交还即关闭，无法确认保存状态。')
            if active:
                reasons.append('请先保存并交还所有工具页面。')
            if self.shutdown is None:
                reasons.append('当前启动方式不支持协商退出，请使用双击入口。')
            return dict(protocolVersion=1, toolId=self.tool_id, root=self.root, pid=os.getpid(),
                        instanceId=self.instance_id, revision=self.revision, taskState=task_state,
                        activeJobs=running, queuedJobs=queued, activeRequests=self.active_requests,
                        saveState=save_state, clients=dict(active=active + released, released=released, lost=lost,
                                                         untracked=int(self.untracked)),
                        lastActivityAt=self.last_activity, canShutdown=not reasons and not self.committed,
                        canUnload=False, modelLoaded=None if task_unknown or self.workers else state.get('modelLoaded', False),
                        reasons=reasons, notes=[self.model_note] if self.model_note else [],
                        controlToken=self.token, draining=bool(self.prepared))

    def session(self, body):
        with self.lock:
            self.expire()
            if body.get('instanceId', self.instance_id) != self.instance_id:
                raise LifecycleError('页面属于旧实例，请重新打开工具。')
            sid, action = body.get('sessionId'), body.get('action')
            if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', sid):
                raise LifecycleError('页面会话标识无效。', 400)
            if action not in {'heartbeat', 'release', 'resume', 'close'}:
                raise LifecycleError('页面会话操作无效。', 400)
            existing = self.sessions.get(sid)
            if self.prepared and (action == 'resume' or existing is None):
                raise LifecycleError('工具正在协商退出，请取消关闭后重试。')
            if action == 'close':
                if existing and existing['released']:
                    del self.sessions[sid]
                elif existing:
                    existing['closed'] = True
                else:
                    self.untracked = True
                self.touch()
                return {'ok': True}
            if existing is None:
                if len(self.sessions) >= 256:
                    self.untracked = True
                    self.touch()
                    raise LifecycleError('页面会话过多，无法安全自动关闭。')
                existing = self.sessions[sid] = dict(seen=self.now(), released=False, closed=False)
                self.ever_observed = True
                self.touch()
            if action in {'release', 'resume'}:
                existing['released'] = action == 'release'
                self.touch()
            elif existing['closed'] or self.now() - existing['seen'] > 60000:
                self.touch()
            existing['seen'], existing['closed'] = self.now(), False
            return dict(ok=True, released=existing['released'], instanceId=self.instance_id)

    def control(self, body):
        with self.lock:
            self.expire()
            if body.get('instanceId') != self.instance_id:
                raise LifecycleError('实例已变化，请刷新 Hub 状态。')
            action = body.get('action')
            if action == 'releaseModels':
                raise LifecycleError(self.model_note or '此工具没有可独立释放的常驻模型。')
            if action == 'prepareShutdown':
                status = self.snapshot()
                if self.prepared or body.get('revision') != status['revision'] or not status['canShutdown']:
                    raise LifecycleError('状态已变化或工具仍受保护，请重新读取状态。')
                self.prepared = dict(nonce=secrets.token_urlsafe(24), expiresAt=self.now() + 5000)
                return dict(ok=True, **self.prepared)
            if action in {'commitShutdown', 'cancelShutdown'}:
                if not self.prepared or body.get('nonce') != self.prepared['nonce'] or self.committed:
                    raise LifecycleError('退出凭据已失效，请重新准备。')
                if action == 'cancelShutdown':
                    self.prepared = None
                    self.touch()
                    return {'ok': True}
                if not self.snapshot()['canShutdown']:
                    self.prepared = None
                    self.touch()
                    raise LifecycleError('后台或页面状态变化，已取消退出。')
                self.committed = True
                return {'ok': True, 'shuttingDown': True}
            raise LifecycleError('不支持的控制操作。', 400)

    def is_static(self, scope):
        path = scope['path']
        return (scope['method'] in {'GET', 'HEAD'} and
                (path in self.static_paths or path.startswith('/assets/')))

    def begin_request(self, scope, headers):
        with self.lock:
            self.expire()
            if self.prepared:
                raise LifecycleError('工具正在协商退出，暂不接收新业务请求。', 503)
            self.active_requests += 1
            sid = headers.get('x-hub-session')
            session = self.sessions.get(sid)
            media = scope['method'] in {'GET', 'HEAD'} and any(p.fullmatch(scope['path']) for p in self.media_paths)
            if session:
                # A released page must resume before any new business request.
                if session['released']:
                    self.active_requests -= 1
                    raise LifecycleError('此页面已交还 Hub，请先恢复使用。')
                session['seen'], session['closed'] = self.now(), False
            elif not media:
                self.untracked = True
            self.touch()

    def end_request(self):
        with self.lock:
            self.active_requests -= 1
            self.touch()

    def begin_worker(self):
        with self.lock:
            self.expire()
            if self.prepared:
                raise LifecycleError('工具正在退出，不能启动模型任务。')
            token = secrets.token_hex(16)
            self.workers.add(token)
            self.touch()
            return token

    def end_worker(self, token, *, verified=True):
        with self.lock:
            self.workers.discard(token)
            self.worker_unknown |= not verified
            self.touch()


class HubMiddleware:
    def __init__(self, app, lifecycle):
        self.app, self.lifecycle = app, lifecycle

    @staticmethod
    async def respond(send, status, value, *, content_type='application/json; charset=utf-8'):
        content = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode('utf-8')
        await send(dict(type='http.response.start', status=status, headers=[
            (b'content-type', content_type.encode()), (b'content-length', str(len(content)).encode()),
            (b'cache-control', b'no-store'), (b'x-content-type-options', b'nosniff')]))
        await send(dict(type='http.response.body', body=content))

    @staticmethod
    def validate_source(scope, headers):
        host = headers.get('host', '')
        parsed = urlsplit('http://' + host)
        if parsed.hostname not in {'localhost', '127.0.0.1', '::1', 'testserver'}:
            raise LifecycleError('仅允许本机请求。', 403)
        origin = headers.get('origin')
        if origin and origin != f"{scope.get('scheme', 'http')}://{host}":
            raise LifecycleError('不允许跨站操作本机工具。', 403)
        if headers.get('sec-fetch-site') == 'cross-site':
            raise LifecycleError('不允许跨站访问本机工具。', 403)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        runtime = self.lifecycle
        headers = {k.decode('latin1').lower(): v.decode('latin1') for k, v in scope['headers']}
        path = scope['path']
        try:
            self.validate_source(scope, headers)
            if path.startswith('/api/hub/'):
                if scope['method'] == 'GET' and path == '/api/hub/status':
                    return await self.respond(send, 200, runtime.snapshot())
                if scope['method'] == 'GET' and path == '/api/hub/bridge.js':
                    try:
                        content = runtime.bridge_path.read_bytes()
                    except OSError:
                        return await self.respond(send, 404, {'detail': '页面桥尚未安装。'})
                    prefix = ('window.__CREATOR_HUB_READONLY_POSTS__=' + json.dumps(runtime.readonly_posts) + ';\n').encode()
                    return await self.respond(send, 200, prefix + content, content_type='application/javascript; charset=utf-8')
                if scope['method'] != 'POST' or path not in {'/api/hub/control', '/api/hub/session'}:
                    raise LifecycleError('接口不存在。', 404)
                if not secrets.compare_digest(headers.get('x-hub-control', ''), runtime.token):
                    raise LifecycleError('控制凭据无效。', 403)
                raw = bytearray()
                while True:
                    event = await receive()
                    if event['type'] == 'http.disconnect':
                        raise LifecycleError('请求已断开。', 400)
                    raw.extend(event.get('body', b''))
                    if len(raw) > 4096:
                        raise LifecycleError('请求过大。', 413)
                    if not event.get('more_body'):
                        break
                try:
                    body = json.loads(raw)
                    if not isinstance(body, dict):
                        raise ValueError()
                except (ValueError, TypeError):
                    raise LifecycleError('JSON 请求无效。', 400)
                result = runtime.session(body) if path.endswith('/session') else runtime.control(body)
                await self.respond(send, 200, result)
                if result.get('shuttingDown'):
                    # Response is sent first; Uvicorn drains accepted work normally.
                    asyncio.get_running_loop().call_soon(runtime.shutdown)
                return
            if path in runtime.health_paths or runtime.is_static(scope):
                return await self.app(scope, receive, send)
            runtime.begin_request(scope, headers)
        except (LifecycleError, ValueError) as exc:
            return await self.respond(send, getattr(exc, 'status', 400), {'detail': str(getattr(exc, 'message', '请求地址无效。'))})
        try:
            await self.app(scope, receive, send)
        finally:
            runtime.end_request()
