"""Ten fresh owned loopback instances, no user data/model/provider calls."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VOICE_FIXTURE = r'''
import asyncio, sys
from contextlib import asynccontextmanager
from pathlib import Path
root, fixture, port = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
sys.path.insert(0, str(root / 'upstream/voicebox'))
from fastapi import FastAPI
from backend.services import task_queue
from backend.services.local_hub import install
import uvicorn
@asynccontextmanager
async def lifespan(app):
    task_queue.init_queue()
    yield
    task_queue._generation_worker_task.cancel()
    try: await task_queue._generation_worker_task
    except asyncio.CancelledError: pass
app = FastAPI(lifespan=lifespan)
runtime = install(app, fixture)
server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='warning'))
runtime.shutdown = lambda: setattr(server, 'should_exit', True)
server.run()
'''


class ProcessTests(unittest.TestCase):
    def test_ten_isolated_cooperative_start_stop_cycles(self):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for iteration in range(10):
            with self.subTest(iteration=iteration), tempfile.TemporaryDirectory(prefix='audio-hub-cycle-') as directory:
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = sock.getsockname()[1]
                base = f'http://127.0.0.1:{port}'
                env = dict(os.environ, SOUNDBOX_DATA_DIR=directory, SOUNDBOX_NO_SEED='1', PYTHONUTF8='1')
                soundbox = (ROOT / 'server/runner.py').exists()
                command = [sys.executable, '-m', 'server.runner', '--port', str(port)] if soundbox else [
                    sys.executable, '-c', VOICE_FIXTURE, str(ROOT), directory, str(port)]
                def request(path, body=None, token=None):
                    headers = {'Content-Type':'application/json'}
                    if token:
                        headers['X-Hub-Control'] = token
                    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
                    with opener.open(req, timeout=2) as response:
                        return json.load(response)
                with open(Path(directory) / 'fixture.log', 'wb') as log:
                    child = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                        stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                    try:
                        deadline, state = time.monotonic() + 15, None
                        while time.monotonic() < deadline and child.poll() is None:
                            try:
                                state = request('/api/hub/status')
                                break
                            except (OSError, ValueError, urllib.error.URLError):
                                time.sleep(.05)
                        self.assertIsNotNone(state, f'Fixture did not start (exit={child.poll()})')
                        expected_root = ROOT if soundbox else Path(directory)
                        self.assertEqual(Path(state['root']).resolve(), expected_root.resolve())
                        self.assertIsInstance(state['pid'], int)
                        self.assertFalse(state['canShutdown'])
                        token, instance = state['controlToken'], state['instanceId']
                        for action in ['heartbeat', 'release']:
                            request('/api/hub/session', dict(sessionId='fixture_page_01', action=action, instanceId=instance), token)
                        state = request('/api/hub/status')
                        self.assertTrue(state['canShutdown'], state['reasons'])
                        prepared = request('/api/hub/control', dict(action='prepareShutdown', instanceId=instance,
                                                                  revision=state['revision']), token)
                        committed = request('/api/hub/control', dict(action='commitShutdown', instanceId=instance,
                                                                   nonce=prepared['nonce']), token)
                        self.assertTrue(committed['shuttingDown'])
                        self.assertEqual(child.wait(timeout=8), 0)
                    finally:
                        # The Popen handle belongs only to this isolated fixture.
                        if child.poll() is None:
                            # Windows venv python.exe may be a launcher process.
                            # Close the verified fixture via protocol before its
                            # wrapper; never assume wrapper PID is the listener.
                            if state and Path(state.get('root', '')).resolve() == expected_root.resolve():
                                try:
                                    for action in ['heartbeat', 'release']:
                                        request('/api/hub/session', dict(sessionId='fixture_page_01', action=action), state['controlToken'])
                                    current = request('/api/hub/status')
                                    ticket = request('/api/hub/control', dict(action='prepareShutdown', instanceId=current['instanceId'],
                                        revision=current['revision']), current['controlToken'])
                                    request('/api/hub/control', dict(action='commitShutdown', instanceId=current['instanceId'],
                                        nonce=ticket['nonce']), current['controlToken'])
                                    child.wait(timeout=8)
                                except (OSError, ValueError, subprocess.TimeoutExpired):
                                    pass
                        if child.poll() is None:
                            child.terminate()
                            child.wait(timeout=8)


if __name__ == '__main__':
    unittest.main()
