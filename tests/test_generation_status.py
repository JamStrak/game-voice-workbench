"""Read-only batched progress checks must stay bounded and preserve terminal state."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'upstream/voicebox'))

from fastapi import Response
from pydantic import ValidationError
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from backend.database import Generation
from backend.database.models import Base
from backend.routes.generation_status import StatusRequest, generation_status_snapshot


class GenerationStatusTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.db.add_all([
            Generation(id=str(i), profile_id='voice', text='台词', language='zh',
                       status=status, duration=1.5, source='rest' if i == 2 else 'manual',
                       error='cancelled' if status == 'failed' else None)
            for i, status in enumerate(['generating', 'loading_model', 'completed', 'failed'])
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_one_query_covers_multiple_statuses_missing_ids_and_duplicates(self):
        statements = []
        event.listen(self.engine, 'before_cursor_execute', lambda c, cu, s, p, ct, e: statements.append(s))
        response = Response()
        result = generation_status_snapshot(StatusRequest(ids=['3', '0', '2', 'missing', '1', '2']), response, self.db)
        self.assertEqual(len(statements), 1)
        self.assertEqual([item['id'] for item in result], ['3', '0', '2', 'missing', '1'])
        self.assertEqual([item['status'] for item in result], ['failed', 'generating', 'completed', 'not_found', 'loading_model'])
        self.assertEqual(result[0]['error'], 'cancelled')
        self.assertEqual(result[2]['source'], 'rest')
        self.assertEqual(result[2]['duration'], 1.5)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertFalse(self.db.dirty)

    def test_later_poll_sees_completion_without_losing_original_generation(self):
        request = StatusRequest(ids=['0'])
        self.assertEqual(generation_status_snapshot(request, Response(), self.db)[0]['status'], 'generating')
        self.db.query(Generation).filter_by(id='0').update({'status': 'completed', 'duration': 2.75})
        self.db.commit()
        result = generation_status_snapshot(request, Response(), self.db)
        self.assertEqual((result[0]['status'], result[0]['duration']), ('completed', 2.75))
        self.assertEqual(self.db.query(Generation).count(), 4)

    def test_empty_and_request_limits(self):
        self.assertEqual(generation_status_snapshot(StatusRequest(ids=[]), Response(), self.db), [])
        self.assertEqual(len(StatusRequest(ids=[str(i) for i in range(100)]).ids), 100)
        for ids in [[''] , ['x' * 129], ['x'] * 101]:
            with self.assertRaises(ValidationError):
                StatusRequest(ids=ids)


if __name__ == '__main__':
    unittest.main()
