"""Exercise actual local queue and worker ownership without models or subprocesses."""
import asyncio
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'upstream/voicebox'))
from backend.services import local_hub, local_inference, task_queue
from backend.services.hub_lifecycle import HubLifecycle


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        for task in list(task_queue._background_tasks) + list(task_queue._running_generation_tasks.values()):
            task.cancel()
        await asyncio.sleep(0)

    async def test_actual_serial_queue_and_non_queue_background_are_counted(self):
        task_queue.init_queue(force=True)
        finish = asyncio.Event()
        async def job():
            await finish.wait()
        task_queue.enqueue_generation('first', job())
        task_queue.enqueue_generation('second', job())
        await asyncio.sleep(0)
        status = local_hub.task_snapshot()
        self.assertEqual((status['activeJobs'], status['queuedJobs']), (1, 1))
        task_queue.create_background_task(job())
        self.assertEqual(local_hub.task_snapshot()['activeJobs'], 2)
        finish.set()
        await task_queue._generation_queue.join()
        await asyncio.sleep(0)
        self.assertEqual(local_hub.task_snapshot()['activeJobs'], 0)
        self.assertFalse(local_hub.task_snapshot()['unknown'])

    async def test_dead_generation_worker_is_unknown_not_idle(self):
        task_queue.init_queue(force=True)
        task_queue._generation_worker_task.cancel()
        await asyncio.sleep(0)
        self.assertTrue(local_hub.task_snapshot()['unknown'])


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_is_owned_until_exit_without_loading_model(self):
        runtime = HubLifecycle('voice-workbench', ROOT, lambda:dict(activeJobs=0, queuedJobs=0))
        proc = mock.Mock(returncode=0)
        proc.poll.return_value = 0
        def start(*args, **kwargs):
            self.assertEqual(runtime.snapshot()['taskState'], 'busy')
            return proc
        with tempfile.TemporaryDirectory(prefix='voice-hub-worker-') as temp:
            folder = Path(temp)
            guard = folder / 'fixture_guard.py'
            guard.write_text('# Never executed\n')
            with mock.patch.object(local_hub, 'runtime', runtime), mock.patch.object(local_inference.subprocess, 'Popen', side_effect=start):
                await local_inference.run_worker(folder, dict(config={'resource_guard':str(guard)}))
        self.assertEqual(runtime.snapshot()['taskState'], 'idle')
        self.assertFalse(runtime.workers)

    async def test_failed_cleanup_preserves_unknown_and_blocks_shutdown(self):
        runtime = HubLifecycle('voice-workbench', ROOT, lambda:dict(activeJobs=0, queuedJobs=0))
        proc = mock.Mock(returncode=None)
        proc.poll.return_value = None
        proc.wait.side_effect = subprocess.TimeoutExpired('fixture', 15)
        async def cancel_sleep(delay):
            raise asyncio.CancelledError()
        with tempfile.TemporaryDirectory(prefix='voice-hub-cancel-') as temp:
            folder = Path(temp)
            guard = folder / 'fixture_guard.py'
            guard.write_text('# Never executed\n')
            with mock.patch.object(local_hub, 'runtime', runtime), \
                 mock.patch.object(local_inference.subprocess, 'Popen', return_value=proc), \
                 mock.patch.object(local_inference.asyncio, 'sleep', side_effect=cancel_sleep):
                with self.assertRaises(subprocess.TimeoutExpired):
                    await local_inference.run_worker(folder, dict(config={'resource_guard':str(guard)}))
        self.assertEqual(runtime.snapshot()['taskState'], 'unknown')
        self.assertFalse(runtime.snapshot()['canShutdown'])

    def test_adapter_does_not_whitelist_business_json_or_export_as_media(self):
        app = mock.Mock()
        previous = local_hub.runtime
        try:
            runtime = local_hub.install(app, ROOT)
            for path in ['/history', '/stories', '/settings/generation', '/settings/captures',
                         '/generations/status', '/local/batches/a/export', '/profiles/a/export']:
                self.assertFalse(runtime.is_static(dict(path=path, method='GET')))
                self.assertFalse(any(regex.fullmatch(path) for regex in runtime.media_paths))
            self.assertEqual(runtime.readonly_posts, ['/generations/status'])
        finally:
            local_hub.runtime = previous


if __name__ == '__main__':
    unittest.main()
