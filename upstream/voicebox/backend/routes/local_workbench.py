"""Small numbered-dialogue extension. Voicebox owns profiles/generations/versions."""
import io, json, os, re, uuid, zipfile
from pathlib import Path
from fastapi import HTTPException, Depends
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session
from .. import config, models
from ..database import get_db, Generation, VoiceProfile
from ..services import versions
from ..services.local_expression import expression_capabilities, validate_expression
from ..services.local_runtime import load_configuration, qwen_files_ready
from .generations import generate_speech, cancel_generation, prepare_generation

ROOT = Path(__file__).resolve().parents[4]
BATCHES = ROOT/'data'/'batches'

class Line(BaseModel):
    number: str = Field(min_length=1, max_length=50, pattern=r'^[\w\-]+$')
    role: str = Field(min_length=1, max_length=50)
    profile_id: str
    text: str = Field(min_length=1, max_length=2000)
    expression: models.ExpressionConfig | None = None

    @field_validator('number')
    @classmethod
    def windows_filename(cls, value):
        reserved={'con','prn','aux','nul'} | {f'{p}{n}' for p in ('com','lpt') for n in range(1,10)}
        if value.casefold() in reserved:
            raise ValueError('台词编号不能使用 Windows 保留文件名')
        return value

class Batch(BaseModel):
    title: str = Field(default='角色台词', min_length=1, max_length=100)
    lines: list[Line] = Field(min_length=1, max_length=50)

    @field_validator('lines')
    @classmethod
    def unique_numbers(cls, rows):
        if len({r.number.casefold() for r in rows}) != len(rows):
            raise ValueError('台词编号不能重复（不区分大小写）')
        return rows

class Selection(BaseModel):
    generation_id: str
    version_id: str

def batch_file(batch_id):
    try: uuid.UUID(batch_id)
    except ValueError: raise HTTPException(400, '无效批次编号')
    return BATCHES/f'{batch_id}.json'

def read_batch(batch_id):
    path = batch_file(batch_id)
    if not path.exists(): raise HTTPException(404, '批次不存在')
    return json.loads(path.read_text(encoding='utf-8'))

def save_batch(batch):
    BATCHES.mkdir(parents=True, exist_ok=True)
    path = batch_file(batch['id'])
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(batch, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)

def generation_request(line, db):
    profile = db.query(VoiceProfile).filter_by(id=line['profile_id']).first()
    if not profile: raise HTTPException(400, '声音档案不存在')
    engine = 'qwen_custom_voice' if profile.voice_type == 'preset' else 'qwen'
    request = models.GenerationRequest(profile_id=profile.id, text=line['text'],
        language='zh', engine=engine, model_size='0.6B', normalize=False, seed=20260916,
        expression=line.get('expression'))
    prepare_generation(request, profile)
    return request


async def enqueue(line, db):
    return await generate_speech(generation_request(line, db), db)

def register_local_routes(app):
    @app.get('/local/expression/capabilities')
    async def get_expression_capabilities():
        return expression_capabilities()

    @app.post('/local/expression/analyze')
    async def analyze_expression(data: models.ExpressionAnalysisRequest):
        from ..services.local_inference import analyze_expression as run_analysis
        try:
            if data.expression.mode != 'auto':
                raise ValueError('自动分析接口只接受自动情绪模式；手动选择无需分析。')
            expression = validate_expression(data.expression)
            return await run_analysis(data.text, expression)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get('/local/identity')
    async def identity():
        return {'app':'voice-workbench', 'root':str(ROOT), 'version':'0.1.0', 'pid':os.getpid()}

    @app.get('/workbench')
    async def workbench():
        # Direct visits and refreshes enter the same React application as '/'.
        return FileResponse(ROOT/'upstream'/'voicebox'/'frontend'/'index.html', media_type='text/html')

    @app.get('/models/status')
    async def model_status():
        cfg = load_configuration(ROOT)
        output = []
        for name, key, repo in [('qwen-tts-0.6B','base_model','Qwen/Qwen3-TTS-12Hz-0.6B-Base'),
                                ('qwen-custom-voice-0.6B','custom_voice_model','Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')]:
            path = Path(cfg[key]); path = path if path.is_absolute() else ROOT/path
            ready = qwen_files_ready(path, key)
            output.append(dict(model_name=name, display_name=name, hf_repo_id=repo,
                               downloaded=ready, downloading=False, loaded=False, size_mb=1700))
        return {'models': output}

    @app.get('/local/batches')
    async def list_batches():
        BATCHES.mkdir(parents=True, exist_ok=True)
        return [json.loads(p.read_text(encoding='utf-8')) for p in sorted(BATCHES.glob('*.json'), key=lambda p:p.stat().st_mtime, reverse=True)]

    @app.post('/local/batches')
    async def new_batch(data: Batch, db: Session = Depends(get_db)):
        if len({l.number for l in data.lines}) != len(data.lines): raise HTTPException(400, '台词编号不能重复')
        # Validate every profile and emotion before creating any generations.
        for line in data.lines:
            generation_request(line.model_dump(), db)
        batch = dict(id=str(uuid.uuid4()), title=data.title, lines=[])
        for line in data.lines:
            row = line.model_dump()
            gen = await enqueue(row, db)
            row['generations'] = [gen.id]
            batch['lines'].append(row)
        save_batch(batch)
        return batch

    @app.get('/local/batches/{batch_id}')
    async def get_batch(batch_id: str, db: Session = Depends(get_db)):
        batch = read_batch(batch_id)
        for line in batch['lines']:
            line['takes'] = []
            for gid in line['generations']:
                gen = db.query(Generation).filter_by(id=gid).first()
                if gen:
                    line['takes'].append(dict(id=gid, text=gen.text, status=gen.status, error=gen.error,
                                             instruct=gen.instruct, expression=gen.expression,
                                             expression_result=gen.expression_result, engine=gen.engine,
                                             model_size=gen.model_size,
                                             versions=[v.model_dump(mode='json') for v in versions.list_versions(gid, db)]))
        return batch

    @app.post('/local/batches/{batch_id}/redo/{number}')
    async def redo(batch_id: str, number: str, data: Line, db: Session = Depends(get_db)):
        batch = read_batch(batch_id)
        row = next((r for r in batch['lines'] if r['number']==number),None)
        if row is None: raise HTTPException(404,'台词不存在')
        for gid in row['generations']:
            gen = db.query(Generation).filter_by(id=gid).first()
            if gen and gen.status in ('generating','loading_model'): raise HTTPException(409,'请等待或停止当前生成')
        new = data.model_dump(); new['number'] = number
        gen = await enqueue(new, db)
        row.update(new); row['generations'].append(gen.id)
        row.pop('preferred_generation_id', None)
        save_batch(batch)
        return {'id':gen.id}

    @app.post('/local/batches/{batch_id}/select/{number}')
    async def select_take(batch_id: str, number: str, data: Selection, db: Session = Depends(get_db)):
        batch = read_batch(batch_id)
        row = next((r for r in batch['lines'] if r['number']==number),None)
        if row is None or data.generation_id not in row['generations']:
            raise HTTPException(400,'该版本不属于当前台词')
        version = versions.get_version(data.version_id,db)
        gen = db.query(Generation).filter_by(id=data.generation_id).first()
        if not version or version.generation_id != data.generation_id or not gen or gen.status!='completed':
            raise HTTPException(400,'只能选择已完成的声音版本')
        versions.set_default_version(data.version_id,db)
        row['preferred_generation_id'] = data.generation_id
        save_batch(batch)
        return {'message':'已设为本条台词的导出版本'}

    @app.post('/local/batches/{batch_id}/cancel')
    async def cancel_batch(batch_id: str, db: Session = Depends(get_db)):
        batch = read_batch(batch_id)
        for row in batch['lines']:
            for gid in row['generations']:
                gen = db.query(Generation).filter_by(id=gid).first()
                if gen and gen.status in ('generating','loading_model'):
                    await cancel_generation(gid, db)
        return {'message':'已停止未完成台词，已完成结果仍保留'}

    @app.get('/local/batches/{batch_id}/export')
    async def export_batch(batch_id: str, db: Session = Depends(get_db)):
        batch = read_batch(batch_id); stream = io.BytesIO(); manifest=[]
        with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
            for row in batch['lines']:
                candidates = list(reversed(row['generations']))
                if row.get('preferred_generation_id') in candidates:
                    candidates.remove(row['preferred_generation_id'])
                    candidates.insert(0,row['preferred_generation_id'])
                for gid in candidates:
                    gen = db.query(Generation).filter_by(id=gid).first()
                    if not gen or gen.status!='completed': continue
                    selected = versions.get_default_version(gid,db)
                    path = config.resolve_storage_path(selected.audio_path if selected else gen.audio_path)
                    if not path or not path.is_file(): continue
                    filename = row['number']+'.wav'
                    archive.write(path, filename)
                    manifest.append(dict(number=row['number'], role=row['role'], text=gen.text, file=filename,
                                         instruct=gen.instruct, expression=gen.expression,
                                         expression_result=gen.expression_result, engine=gen.engine,
                                         model_size=gen.model_size,
                                         generation_id=gid, version_id=selected.id if selected else None))
                    break
            archive.writestr('台词清单.json',json.dumps(manifest,ensure_ascii=False,indent=2))
        if not manifest: raise HTTPException(400,'尚无可导出的完成台词')
        stream.seek(0)
        return StreamingResponse(stream, media_type='application/zip', headers={'Content-Disposition':f'attachment; filename="dialogue-{batch_id[:8]}.zip"'})
