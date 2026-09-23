from redis import Redis
from rq import Queue, Worker
from app.config import get_settings

settings = get_settings()
connection = Redis.from_url(settings.redis_url)
queue = Queue(settings.queue_name, connection=connection)

if __name__ == "__main__":
    Worker([queue], connection=connection).work(with_scheduler=False)
