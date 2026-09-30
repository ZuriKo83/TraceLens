import multiprocessing
import os

bind = os.getenv('TRACELENS_WEB_BIND', '127.0.0.1:8021')
workers = 4
worker_class = 'uvicorn.workers.UvicornWorker'
timeout = 60
graceful_timeout = 30
keepalive = 5
max_requests = 2000
max_requests_jitter = 200
accesslog = '-'
errorlog = '-'
