"""Local web runner adapter; upstream desktop startup remains untouched."""
from pathlib import Path
from .hub_lifecycle import HubLifecycle, HubMiddleware
from . import task_queue

runtime = None


def task_snapshot():
    worker = task_queue._generation_worker_task
    unknown = worker is None or worker.done() or task_queue._generation_queue is None
    extra = sum(1 for task in task_queue._background_tasks
                if task is not worker and not task.done())
    return dict(activeJobs=len(task_queue._running_generation_tasks) + extra,
                queuedJobs=len(task_queue._queued_generation_ids), unknown=unknown,
                modelLoaded=None)


def install(app, root):
    global runtime
    runtime = HubLifecycle(
        'voice-workbench', root, task_snapshot,
        health_paths={'/local/identity'},
        static_paths={'/', '/index.html', '/voices', '/workbench', '/effects', '/models',
                      '/settings', '/settings/general', '/settings/gpu',
                      '/settings/logs', '/settings/mcp', '/settings/about', '/settings/changelog',
                      '/vite.svg', '/favicon.ico'},
        media_paths=[r'/audio/[^/]+', r'/audio/version/[^/]+', r'/samples/[^/]+',
                     r'/profiles/[^/]+/avatar', r'/captures/[^/]+/audio',
                     r'/local/voice-library/[^/]+/samples/[^/]+/audio'],
        readonly_posts=['/generations/status'],
        model_note='本地配音模型由共享资源锁保护，每任务独立 worker 退出后释放；'
                   '没有额外的常驻配音模型卸载操作。未核验其他上游模型权重，modelLoaded 保留未知。')
    app.state.hub_lifecycle = runtime
    app.add_middleware(HubMiddleware, lifecycle=runtime)
    return runtime
