"""Local-only Voicebox host. No model is loaded in the web process."""
import argparse, importlib.util, json, os, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
(ROOT/'cache'/'tmp').mkdir(parents=True,exist_ok=True)
os.environ['TEMP']=os.environ['TMP']=str(ROOT/'cache'/'tmp')
os.environ.update(HF_HOME=str(ROOT/'cache'/'huggingface'), HF_HUB_OFFLINE='1',
                  TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                  NUMBA_CACHE_DIR=str(ROOT/'cache'/'numba'), DO_NOT_TRACK='1')
sys.path.insert(0, str(ROOT/'upstream'/'voicebox'))
from backend.services.local_runtime import load_configuration, resource_guard_path, configure_process_tools
configure_process_tools(ROOT)

if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--port',type=int,default=23164)
    args=parser.parse_args()
    cfg=load_configuration(ROOT)
    # Server exit also closes the job containing all inference guard descendants.
    guard_path=resource_guard_path(ROOT, cfg)
    sys.dont_write_bytecode=True
    spec=importlib.util.spec_from_file_location('local_guard',guard_path)
    guard=importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
    lifetime_job=guard.bind_child_lifetime()
    from backend import config
    config.set_data_dir(ROOT/'data')
    from backend.app import app
    from fastapi import Request
    from fastapi.responses import JSONResponse
    @app.middleware('http')
    async def local_scope(request: Request, call_next):
        if request.url.path in ('/generate/stream', '/profiles/design') or request.url.path.endswith('/compose'):
            return JSONResponse({'detail':'本机版请使用普通生成队列，确保资源锁与取消有效。'},status_code=400)
        origin=request.headers.get('origin')
        if origin and origin != f'http://127.0.0.1:{args.port}' and origin != f'http://localhost:{args.port}':
            return JSONResponse({'detail':'仅允许本机工作台页面操作。'},status_code=403)
        response = await call_next(request)
        if response.headers.get('content-type', '').startswith('text/html'):
            # Local updates must not reopen a cached entry point from another
            # build, while hashed JS/CSS assets can keep their normal caching.
            response.headers['Cache-Control'] = 'no-store'
        return response
    import uvicorn
    from backend.services.local_hub import install
    lifecycle = install(app, ROOT)
    server = uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=args.port,log_level='info'))
    lifecycle.shutdown = lambda: setattr(server, 'should_exit', True)
    server.run()
