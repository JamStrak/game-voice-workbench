"""Protocol tests without user data, provider calls, models or existing services."""
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / 'server' / 'hub_lifecycle.py'
if not MODULE.exists():
    MODULE = ROOT / 'upstream/voicebox/backend/services/hub_lifecycle.py'
spec = importlib.util.spec_from_file_location('isolated_hub_lifecycle', MODULE)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.time = 1000.0
        self.jobs = {'activeJobs': 0, 'queuedJobs': 0}
        self.runtime = hub.HubLifecycle('fixture', ROOT, lambda: self.jobs,
            clock=lambda: self.time, media_paths=[r'/audio/[^/]+'])
        self.stopped = []
        self.runtime.shutdown = lambda: self.stopped.append(True)

    def page(self, sid='page_0001', action='heartbeat'):
        return self.runtime.session(dict(sessionId=sid, action=action))

    def clean(self):
        self.page()
        self.page(action='release')

    def prepare(self):
        status = self.runtime.snapshot()
        return self.runtime.control(dict(action='prepareShutdown', instanceId=self.runtime.instance_id,
                                         revision=status['revision']))

    def test_unobserved_open_and_closed_pages_stay_protected(self):
        self.assertEqual(self.runtime.snapshot()['saveState'], 'unknown')
        self.page()
        self.assertEqual(self.runtime.snapshot()['saveState'], 'protected')
        self.page(action='close')
        self.assertFalse(self.runtime.snapshot()['canShutdown'])
        self.assertEqual(self.runtime.snapshot()['clients']['lost'], 1)

    def test_all_pages_must_release_and_close_only_removes_released_page(self):
        self.clean()
        self.page('page_0002')
        self.assertFalse(self.runtime.snapshot()['canShutdown'])
        self.page('page_0002', 'release')
        self.page(action='close')
        self.assertTrue(self.runtime.snapshot()['canShutdown'])
        self.assertEqual(self.runtime.snapshot()['clients']['released'], 1)
        self.assertEqual(self.runtime.snapshot()['clients']['active'], 1)

    def test_expired_heartbeat_is_unknown_even_after_release(self):
        self.clean()
        self.time += 61
        self.assertEqual(self.runtime.snapshot()['saveState'], 'unknown')
        self.assertFalse(self.runtime.snapshot()['canShutdown'])

    def test_queue_running_and_bad_snapshot_block_shutdown(self):
        self.clean()
        for update in [{'queuedJobs': 2}, {'queuedJobs': 0, 'activeJobs': 1}, {'activeJobs': -1}]:
            self.jobs.update(update)
            self.assertFalse(self.runtime.snapshot()['canShutdown'])
        self.assertEqual(self.runtime.snapshot()['taskState'], 'unknown')

    def test_unknown_business_is_sticky_but_exact_media_get_is_not(self):
        self.clean()
        self.runtime.begin_request(dict(path='/audio/a', method='GET'), {})
        self.assertEqual(self.runtime.snapshot()['activeRequests'], 1)
        self.runtime.end_request()
        self.assertTrue(self.runtime.snapshot()['canShutdown'])
        for scope in [dict(path='/audio/a', method='POST'), dict(path='/export', method='GET')]:
            self.runtime.begin_request(scope, {})
            self.runtime.end_request()
            self.assertEqual(self.runtime.snapshot()['clients']['untracked'], 1)
            self.assertFalse(self.runtime.snapshot()['canShutdown'])

    def test_prepare_blocks_admission_and_resume_cancel_reopens(self):
        self.clean()
        ticket = self.prepare()
        for call in [lambda: self.page(action='resume'), lambda: self.page('page_0002'),
                     lambda: self.runtime.begin_request(dict(path='/generate', method='POST'), {}),
                     self.runtime.begin_worker]:
            with self.assertRaises(hub.LifecycleError):
                call()
        self.runtime.control(dict(action='cancelShutdown', instanceId=self.runtime.instance_id, nonce=ticket['nonce']))
        self.page(action='resume')
        self.assertEqual(self.runtime.snapshot()['saveState'], 'protected')

    def test_expired_nonce_and_old_instance_rejected(self):
        self.clean()
        ticket = self.prepare()
        self.time += 6
        with self.assertRaises(hub.LifecycleError):
            self.runtime.control(dict(action='commitShutdown', instanceId=self.runtime.instance_id, nonce=ticket['nonce']))
        with self.assertRaises(hub.LifecycleError):
            self.runtime.session(dict(sessionId='page_0002', action='heartbeat', instanceId='old'))
        with self.assertRaises(hub.LifecycleError):
            self.runtime.control(dict(action='prepareShutdown', instanceId='old', revision=1))
        self.assertFalse(self.runtime.snapshot()['draining'])

    def test_commit_rechecks_tasks_and_cancels_prepare_if_busy(self):
        self.clean()
        ticket = self.prepare()
        self.jobs['activeJobs'] = 1
        with self.assertRaises(hub.LifecycleError):
            self.runtime.control(dict(action='commitShutdown', instanceId=self.runtime.instance_id, nonce=ticket['nonce']))
        self.assertFalse(self.runtime.snapshot()['draining'])

    def test_released_page_cannot_send_business_without_resume(self):
        self.clean()
        with self.assertRaises(hub.LifecycleError):
            self.runtime.begin_request(dict(path='/generate', method='POST'), {'x-hub-session': 'page_0001'})
        self.assertEqual(self.runtime.snapshot()['activeRequests'], 0)

    def test_worker_cleanup_failure_stays_unknown(self):
        self.clean()
        worker = self.runtime.begin_worker()
        self.assertEqual(self.runtime.snapshot()['taskState'], 'busy')
        self.assertIsNone(self.runtime.snapshot()['modelLoaded'])
        self.runtime.end_worker(worker, verified=False)
        self.assertEqual(self.runtime.snapshot()['taskState'], 'unknown')
        self.assertFalse(self.runtime.snapshot()['canShutdown'])


class MiddlewareTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.runtime = hub.HubLifecycle('fixture', ROOT, lambda: dict(activeJobs=0, queuedJobs=0))
        self.stopped = []
        self.runtime.shutdown = lambda: self.stopped.append(True)

    async def call(self, path, method='GET', body=None, extra=None, app=None):
        messages = []
        async def downstream(scope, receive, send):
            await send(dict(type='http.response.start', status=200, headers=[]))
            await send(dict(type='http.response.body', body=b'ok'))
        headers = {'host': '127.0.0.1:24983', **(extra or {})}
        scope = dict(type='http', path=path, method=method, scheme='http',
                     headers=[(k.encode(), v.encode()) for k, v in headers.items()])
        async def receive():
            return dict(type='http.request', body=json.dumps(body or {}).encode(), more_body=False)
        async def send(message):
            messages.append(message)
        await hub.HubMiddleware(app or downstream, self.runtime)(scope, receive, send)
        return messages[0]['status'], b''.join(m.get('body', b'') for m in messages)

    async def test_token_host_origin_and_cross_site_rejected(self):
        for headers in [{'host': 'evil.test'}, {'origin': 'https://evil.test'}, {'sec-fetch-site': 'cross-site'}]:
            status, _ = await self.call('/api/hub/status', extra=headers)
            self.assertEqual(status, 403)
        status, _ = await self.call('/api/hub/session', 'POST', {'sessionId':'page_0001','action':'heartbeat'})
        self.assertEqual(status, 403)

    async def test_entire_stream_and_background_remain_busy(self):
        self.runtime.session(dict(sessionId='page_0001', action='heartbeat'))
        self.runtime.session(dict(sessionId='page_0001', action='release'))
        self.runtime.media_paths = [__import__('re').compile(r'/audio/one')]
        body_done, background_finish = asyncio.Event(), asyncio.Event()
        async def streaming(scope, receive, send):
            await send(dict(type='http.response.start', status=200, headers=[]))
            await asyncio.sleep(0)
            await send(dict(type='http.response.body', body=b'audio', more_body=False))
            body_done.set()
            await background_finish.wait()
        task = asyncio.create_task(self.call('/audio/one', app=streaming))
        await body_done.wait()
        self.assertEqual(self.runtime.snapshot()['activeRequests'], 1)
        self.assertFalse(self.runtime.snapshot()['canShutdown'])
        background_finish.set()
        await task
        self.assertTrue(self.runtime.snapshot()['canShutdown'])

    async def test_commit_sends_response_before_cooperative_callback(self):
        self.runtime.session(dict(sessionId='page_0001', action='heartbeat'))
        self.runtime.session(dict(sessionId='page_0001', action='release'))
        headers = {'x-hub-control':self.runtime.token}
        body = dict(action='prepareShutdown', instanceId=self.runtime.instance_id,
                    revision=self.runtime.snapshot()['revision'])
        status, raw = await self.call('/api/hub/control', 'POST', body, headers)
        self.assertEqual(status, 200)
        ticket = json.loads(raw)
        body = dict(action='commitShutdown', instanceId=self.runtime.instance_id, nonce=ticket['nonce'])
        status, raw = await self.call('/api/hub/control', 'POST', body, headers)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw)['shuttingDown'])
        self.assertEqual(self.stopped, [])
        await asyncio.sleep(0)
        self.assertEqual(self.stopped, [True])


if __name__ == '__main__':
    unittest.main()
