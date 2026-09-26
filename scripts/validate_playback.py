"""Read-only HTTP playback regression/latency checks; never runs synthesis."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
from pathlib import Path
import statistics
import time
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://127.0.0.1:23164')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    base = urlsplit(args.base)
    if base.scheme != 'http' or base.hostname not in ('localhost', '127.0.0.1'):
        raise ValueError('This validator only targets the local app.')

    def request(path, headers=None, payload=None):
        conn = http.client.HTTPConnection(base.hostname, base.port, timeout=15)
        body = json.dumps(payload).encode() if payload is not None else None
        hdr = dict(headers or {})
        if body is not None:
            hdr['Content-Type'] = 'application/json'
        start = time.perf_counter()
        try:
            conn.request('POST' if body is not None else 'GET', path, body=body, headers=hdr)
            res = conn.getresponse()
            head_ms = (time.perf_counter() - start) * 1000
            data = res.read()
            return {
                'status': res.status, 'headers': dict(res.getheaders()),
                'bytes': len(data), 'head_ms': round(head_ms, 3),
                'total_ms': round((time.perf_counter() - start) * 1000, 3),
            }, data
        finally:
            conn.close()

    def repeated(path):
        samples = [request(path)[0] for _ in range(10)]
        assert all(s['status'] == 200 for s in samples), samples
        return {'first_ms': samples[0]['total_ms'],
                'repeat_median_ms': statistics.median(s['total_ms'] for s in samples[1:]),
                'max_ms': max(s['total_ms'] for s in samples), 'samples': samples}

    identity = json.loads(request('/local/identity')[1])
    tasks = json.loads(request('/tasks/active')[1])
    library = json.loads(request('/local/voice-library')[1])
    previews = [sample for voice in library['voices'] for sample in voice['samples'] if sample['status'] == 'ready']
    checks = []
    for sample in previews:
        result, data = request(sample['audio_url'])
        assert result['status'] == 200 and data[:4] == b'RIFF', result
        digest = hashlib.sha256(data).hexdigest()
        assert not sample.get('sha256') or digest == sample['sha256'], sample['audio_url']
        checks.append({'path': sample['audio_url'], 'sha256': digest, **result})

    path = previews[0]['audio_url']
    first, full = request(path)
    headers = {k.lower(): v for k, v in first['headers'].items()}
    cached, cached_body = request(path, {'If-None-Match': headers['etag']})
    assert cached['status'] == 304 and not cached_body, cached
    partial, part = request(path, {'Range': 'bytes=0-1023'})
    assert partial['status'] == 206 and part == full[:1024], partial

    ids = [s['generation_id'] for p in library['personal_voices'] for s in p['samples'] if s.get('generation_id')]
    ids = list(dict.fromkeys(ids))[:100]
    snapshot, status_body = request('/generations/status', payload={'ids': ids})
    assert snapshot['status'] == 200 and isinstance(json.loads(status_body), list), snapshot

    # Short status reads and range delivery share the server; no held SSE slots.
    def mixed(index):
        if index % 2:
            result, _ = request('/generations/status', payload={'ids': ids})
            assert result['status'] == 200, result
        else:
            result, body = request(previews[index % len(previews)]['audio_url'], {'Range': 'bytes=0-1023'})
            assert result['status'] == 206 and len(body) == 1024, result
        return result

    with ThreadPoolExecutor(max_workers=4) as pool:
        mixed_results = list(pool.map(mixed, range(24)))
    report = {
        'identity': identity, 'active_tasks_at_start': tasks,
        'method': 'HTTP over loopback; fresh connection per request; milliseconds include full response; no GPU/model work',
        'library': repeated('/local/voice-library'), 'preview': repeated(path),
        'ready_sample_count': len(checks), 'sample_checks': checks,
        'conditional_preview': cached, 'range_preview': partial,
        'status_snapshot': snapshot, 'mixed_requests': mixed_results,
        'mixed_median_ms': statistics.median(row['total_ms'] for row in mixed_results),
        'mixed_max_ms': max(row['total_ms'] for row in mixed_results),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ['ready_sample_count', 'mixed_median_ms', 'mixed_max_ms']}, ensure_ascii=False))
    print('library median', report['library']['repeat_median_ms'], 'ms; preview median', report['preview']['repeat_median_ms'], 'ms')
    print(args.output)


if __name__ == '__main__':
    main()
