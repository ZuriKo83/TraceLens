import multiprocessing

bind = '0.0.0.0:8021'
workers = max(2, multiprocessing.cpu_count() * 2 + 1)
worker_class = 'uvicorn.workers.UvicornWorker'
timeout = 60
graceful_timeout = 30
keepalive = 5
max_requests = 2000
max_requests_jitter = 200
accesslog = '-'
errorlog = '-'
