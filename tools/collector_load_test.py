from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time

import httpx


async def one(client, url, token, payload):
    started = time.perf_counter()
    response = await client.post(url, headers={'Authorization': f'Bearer {token}'}, json=payload)
    return response.status_code, time.perf_counter() - started


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8021/api/collector/import')
    parser.add_argument('--token', required=True)
    parser.add_argument('--requests', type=int, default=100)
    parser.add_argument('--concurrency', type=int, default=10)
    args = parser.parse_args()
    payload = {'platform': 'test', 'source_url': 'https://example.com', 'status': 'ok', 'items': [], 'message': 'load-test'}
    sem = asyncio.Semaphore(args.concurrency)
    async with httpx.AsyncClient(timeout=30) as client:
        async def run():
            async with sem:
                return await one(client, args.url, args.token, payload)
        results = await asyncio.gather(*(run() for _ in range(args.requests)))
    elapsed = [value for _, value in results]
    ok = sum(1 for code, _ in results if 200 <= code < 300)
    print(json.dumps({'requests': args.requests, 'success': ok, 'failed': args.requests-ok,
        'avg_ms': round(statistics.mean(elapsed)*1000, 2),
        'p95_ms': round(sorted(elapsed)[max(0, int(len(elapsed)*0.95)-1)]*1000, 2)}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
