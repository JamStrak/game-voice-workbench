"""Local Qwen-only route registration; upstream domains otherwise retained."""
from fastapi import FastAPI
from importlib import import_module

def register_routers(app: FastAPI) -> None:
    for domain in ('health', 'profiles', 'channels', 'generations', 'history',
                   'stories', 'effects', 'audio', 'settings', 'tasks', 'events', 'local_voice_library',
                   'generation_status'):
        app.include_router(import_module(f'{__package__}.{domain}').router)
