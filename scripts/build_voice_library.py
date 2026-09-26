"""Curate built-in previews locally; model workers always use the shared guard.

Maintenance only. Normal use opens the library in the app and plays these files.
Existing completed previews are preserved; interrupted runs can be resumed.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LIBRARY = ROOT / 'data' / 'voice-library'
CATALOG = LIBRARY / 'catalog.json'
VOICES = [
    ('Vivian', 'Vivian · 明亮少女', 'female', 'zh', '明亮、年轻的女声，适合活泼伙伴与轻快引导。', ['女声', '明亮', '伙伴', '普通话']),
    ('Serena', 'Serena · 温柔女声', 'female', 'zh', '温暖轻柔的女声，适合治愈角色、讲述与陪伴。', ['女声', '温柔', '旁白', '普通话']),
    ('Uncle_Fu', 'Uncle Fu · 沉稳长者', 'male', 'zh', '成熟醇厚的男声，适合长者、导师和故事讲述。', ['男声', '成熟', '导师', '普通话']),
    ('Dylan', 'Dylan · 京味青年', 'male', 'zh', '年轻清晰的北京男声，适合市井青年和轻松对话。', ['男声', '青年', '京味', '伙伴']),
    ('Eric', 'Eric · 川味青年', 'male', 'zh', '活泼的成都男声，适合诙谐角色与生活化对话。', ['男声', '活泼', '川味', '商人']),
    ('Ryan', 'Ryan · 活力男声', 'male', 'en', '节奏鲜明的男声，适合行动角色和宣传旁白。英语底色，本库提供中文试听。', ['男声', '有力', '旁白', '英语底色']),
    ('Aiden', 'Aiden · 阳光青年', 'male', 'en', '清亮的美国青年男声，适合爽朗伙伴。英语底色，本库提供中文试听。', ['男声', '阳光', '伙伴', '英语底色']),
    ('Ono_Anna', 'Ono Anna · 轻盈少女', 'female', 'ja', '轻巧活泼的日本女声，适合灵动角色。日语底色，本库提供中文试听。', ['女声', '轻盈', '灵动', '日语底色']),
    ('Sohee', 'Sohee · 温暖女声', 'female', 'ko', '温暖柔和的韩国女声，适合亲切的角色。韩语底色，本库提供中文试听。', ['女声', '温暖', '陪伴', '韩语底色']),
]
LINES = [
    ('natural', '自然', '你好，我会认真说好每一句台词，让故事中的角色鲜活起来。'),
    ('happy', '开心', '太好了，我们终于成功了！'),
    ('angry', '愤怒', '你怎么能这样？我真的很生气！'),
    ('sad', '悲伤', '你走以后，这里就只剩下我了。'),
]


def write_catalog(catalog):
    LIBRARY.mkdir(parents=True, exist_ok=True)
    tmp = CATALOG.with_suffix('.tmp')
    tmp.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(CATALOG)


def initialize():
    if CATALOG.exists():
        return json.loads(CATALOG.read_text(encoding='utf-8'))
    cfg = json.loads((ROOT/'local_config.json').read_text(encoding='utf-8'))
    catalog = dict(schema_version=1, version='2026-09-23', review_status='technical_checks_only', voices=[])
    for speaker, name, gender, native_language, description, tags in VOICES:
        voice_id = 'qwen-' + speaker.lower().replace('_', '-')
        voice = dict(id=voice_id, name=name, speaker=speaker, gender=gender,
                     native_language=native_language, description=description, tags=tags,
                     source_name='Qwen3-TTS 0.6B', language='zh', samples=[])
        for sample_id, label, text in LINES:
            natural = sample_id == 'natural'
            voice['samples'].append(dict(
                id=sample_id, label=label, text=text, language='zh', status='pending',
                expression=dict(mode='natural' if natural else 'manual', emotion='calm' if natural else sample_id,
                                intensity='medium', instruction=''),
                audio_path=f'{voice_id}/{sample_id}.wav', duration=None,
                engine='qwen_custom_voice' if natural else 'indextts', model_size='0.6B' if natural else None,
                model_revision=cfg['custom_voice_revision' if natural else 'emotion_revision'],
                seed=20260923, review_status='not_listened'))
        catalog['voices'].append(voice)
    write_catalog(catalog)
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--initialize-only', action='store_true')
    parser.add_argument('--stage', choices=['all', 'natural', 'emotion'], default='all')
    args = parser.parse_args()
    initialize()
    if args.initialize_only:
        print(str(CATALOG)); return
    cfg = json.loads((ROOT/'local_config.json').read_text(encoding='utf-8'))
    guard = Path(cfg['resource_guard'])
    if not guard.is_file():
        raise RuntimeError('共享资源锁脚本不存在，不能启动声音库制作。')
    evidence = ROOT/'validation'/'voice-library-20260923'
    evidence.mkdir(parents=True, exist_ok=True)
    stages = ['natural', 'emotion'] if args.stage == 'all' else [args.stage]
    for stage in stages:
        python = ROOT/('.venv' if stage == 'natural' else '.venv-emotion')/'Scripts'/'python.exe'
        command = [sys.executable, str(guard), '--owner', '配音工作台-声音库制作', '--timeout', '900', '--',
                   str(python), str(ROOT/'scripts'/'voice_library_worker.py'), stage]
        with (evidence/f'{stage}.log').open('a', encoding='utf-8') as log:
            proc = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=log,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                code = proc.wait(timeout=3600)
            finally:
                if proc.poll() is None:
                    proc.terminate(); proc.wait(timeout=15)
        print(f'{stage}: exit {code}', flush=True)
        if code:
            raise SystemExit(code)


if __name__ == '__main__':
    main()
