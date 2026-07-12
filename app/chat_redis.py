from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from typing import Any

from fastapi import WebSocket
from redis.asyncio import Redis

logger = logging.getLogger(__name__)


class RedisChatManager:
    """Cross-worker WebSocket fan-out and presence using Redis Pub/Sub."""

    def __init__(self, redis_url: str, *, channel: str = "tracelens:community:chat", presence_key: str = "tracelens:community:presence") -> None:
        self.redis = Redis.from_url(redis_url, decode_responses=True)
        self.channel = channel
        self.presence_key = presence_key
        self.connections: set[WebSocket] = set()
        self.tokens: dict[WebSocket, str] = {}
        self.heartbeats: dict[WebSocket, asyncio.Task] = {}
        self.lock = asyncio.Lock()
        self.listener_task: asyncio.Task | None = None

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        token = secrets.token_urlsafe(18)
        async with self.lock:
            self.connections.add(websocket)
            self.tokens[websocket] = token
            if self.listener_task is None or self.listener_task.done():
                self.listener_task = asyncio.create_task(self._listen())
            self.heartbeats[websocket] = asyncio.create_task(self._heartbeat(token))
        await self._touch_presence(token)
        await self._publish_presence()

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self.lock:
            self.connections.discard(websocket)
            token = self.tokens.pop(websocket, None)
            heartbeat = self.heartbeats.pop(websocket, None)
        if heartbeat:
            heartbeat.cancel()
        if token:
            try:
                await self.redis.zrem(self.presence_key, token)
            except Exception:
                logger.exception("Failed to remove chat presence token")
        await self._publish_presence()

    async def broadcast(self, payload: dict[str, Any]) -> None:
        try:
            await self.redis.publish(self.channel, json.dumps(payload, ensure_ascii=False))
        except Exception:
            logger.exception("Redis chat publish failed; using local fallback")
            await self._send_local(payload)

    async def _listen(self) -> None:
        while True:
            pubsub = self.redis.pubsub()
            try:
                await pubsub.subscribe(self.channel)
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    try:
                        payload = json.loads(message.get("data") or "{}")
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if isinstance(payload, dict):
                        await self._send_local(payload)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Redis chat listener failed; reconnecting")
                await asyncio.sleep(1)
            finally:
                try:
                    await pubsub.close()
                except Exception:
                    pass

    async def _send_local(self, payload: dict[str, Any]) -> None:
        stale: list[WebSocket] = []
        async with self.lock:
            targets = tuple(self.connections)
        for connection in targets:
            try:
                await connection.send_json(payload)
            except Exception:
                stale.append(connection)
        for connection in stale:
            await self.disconnect(connection)

    async def _heartbeat(self, token: str) -> None:
        try:
            while True:
                await self._touch_presence(token)
                await asyncio.sleep(20)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Chat presence heartbeat failed")

    async def _touch_presence(self, token: str) -> None:
        now = int(time.time())
        try:
            pipe = self.redis.pipeline()
            pipe.zadd(self.presence_key, {token: now})
            pipe.zremrangebyscore(self.presence_key, 0, now - 60)
            pipe.expire(self.presence_key, 120)
            await pipe.execute()
        except Exception:
            logger.exception("Failed to update chat presence")

    async def _publish_presence(self) -> None:
        try:
            now = int(time.time())
            pipe = self.redis.pipeline()
            pipe.zremrangebyscore(self.presence_key, 0, now - 60)
            pipe.zcard(self.presence_key)
            results = await pipe.execute()
            online = int(results[-1])
        except Exception:
            async with self.lock:
                online = len(self.connections)
        await self.broadcast({"type": "presence", "online": online})
