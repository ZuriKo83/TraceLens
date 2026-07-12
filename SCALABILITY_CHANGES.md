# Scalability changes

- Administrator users, scan logs, and activities are loaded 50 records per page.
- Administrator filters preserve independent page positions.
- SQLite uses WAL mode, a 30-second busy timeout, and foreign-key enforcement.
- PostgreSQL connections use a bounded connection pool.
- Activity and scan-log composite indexes are created for new and existing databases.
- Collector duplicate detection fetches matching activities in one query instead of one query per item.
- The original 1.0.0 archive and extension manifest version are unchanged.
