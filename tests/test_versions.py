"""Core regression: retry preserves original + profile effects + previous takes."""
import asyncio, json, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'upstream/voicebox'))

class RetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_regenerate_preserves_selected_effects_then_respects_selected_original(self):
        from backend import config,database,models
        from backend.services import profiles,history,versions
        from backend.services.generation import run_generation
        previous=config.get_data_dir()
        with tempfile.TemporaryDirectory(dir=ROOT/'validation') as temp:
            config.set_data_dir(temp);database.init_db();db=next(database.get_db())
            try:
                p=await profiles.create_profile(models.VoiceProfileCreate(name='Role variant',voice_type='preset',preset_engine='qwen_custom_voice',preset_voice_id='Ryan',language='zh'),db)
                chain=[{'type':'tempo','enabled':True,'params':{'speed':1.25}}, {'type':'pitch','enabled':True,'params':{'semitones':-2}}]
                g=await history.create_generation(profile_id=p.id,text='测试',language='zh',audio_path='',duration=0,seed=1,db=db,status='generating',engine='qwen_custom_voice',model_size='0.6B',effects_chain_snapshot=chain)
                audio=(np.sin(np.arange(48000)/24000*440*2*np.pi)*.1).astype('float32')
                with patch('backend.services.local_inference.infer',new=AsyncMock(return_value=(audio,24000))):
                    await run_generation(generation_id=g.id,profile_id=p.id,text='测试',language='zh',engine='qwen_custom_voice',model_size='0.6B',seed=1,mode='generate',effects_chain=chain)
                    old=versions.list_versions(g.id,db)
                    saved={v.audio_path:config.resolve_storage_path(v.audio_path).read_bytes() for v in old}
                    profile=db.query(database.VoiceProfile).filter_by(id=p.id).one()
                    profile.effects_chain=json.dumps([{'type':'tempo','params':{'speed':0.75}}]);db.commit()
                    await run_generation(generation_id=g.id,profile_id=p.id,text='测试',language='zh',engine='qwen_custom_voice',model_size='0.6B',seed=1,mode='regenerate')
                    after=versions.list_versions(g.id,db)
                    self.assertEqual(len(after),4)
                    selected=versions.get_default_version(g.id,db)
                    self.assertEqual([e.model_dump() for e in selected.effects_chain],chain)
                    self.assertIsNotNone(selected.source_version_id)
                    for path,content in saved.items():self.assertEqual(config.resolve_storage_path(path).read_bytes(),content)
                    original=next(v for v in old if v.effects_chain is None)
                    versions.set_default_version(original.id,db)
                    await run_generation(generation_id=g.id,profile_id=p.id,text='测试',language='zh',engine='qwen_custom_voice',model_size='0.6B',seed=1,mode='regenerate')
                    self.assertEqual(len(versions.list_versions(g.id,db)),5)
                    self.assertIsNone(versions.get_default_version(g.id,db).effects_chain)
            finally:
                db.close();database.session.engine.dispose();config.set_data_dir(previous)

    async def test_retry_creates_raw_and_processed_versions_without_overwrite(self):
        from backend import config,database,models
        from backend.services import profiles,history,versions
        from backend.services.generation import run_generation
        previous=config.get_data_dir()
        with tempfile.TemporaryDirectory(dir=ROOT/'validation') as temp:
            config.set_data_dir(temp);database.init_db();db=next(database.get_db())
            try:
                p=await profiles.create_profile(models.VoiceProfileCreate(name='Retry test',voice_type='preset',preset_engine='qwen_custom_voice',preset_voice_id='Ryan',language='zh'),db)
                row=db.query(database.VoiceProfile).filter_by(id=p.id).one()
                row.effects_chain=json.dumps([{'type':'tempo','params':{'speed':1.25}}]);db.commit()
                g=await history.create_generation(profile_id=p.id,text='测试',language='zh',audio_path='',duration=0,seed=1,db=db,status='failed',engine='qwen_custom_voice',model_size='0.6B')
                audio=(np.sin(np.arange(24000)/24000*440*2*np.pi)*.1).astype('float32')
                with patch('backend.services.local_inference.infer',new=AsyncMock(return_value=(audio,24000))):
                    for _ in range(2):
                        await run_generation(generation_id=g.id,profile_id=p.id,text='测试',language='zh',engine='qwen_custom_voice',model_size='0.6B',seed=1,mode='retry')
                items=versions.list_versions(g.id,db)
                self.assertEqual(len(items),4)
                self.assertEqual(len({v.audio_path for v in items}),4)
                self.assertEqual(sum(v.effects_chain is None for v in items),2)
                self.assertEqual(sum(v.is_default for v in items),1)
                for v in items:self.assertTrue(config.resolve_storage_path(v.audio_path).is_file())
            finally:
                db.close();database.session.engine.dispose();config.set_data_dir(previous)

if __name__=='__main__':unittest.main()
