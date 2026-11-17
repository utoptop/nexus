use crate::{
    Result,
    config::Config,
    protocol::{MAX_BATCH_BYTES, TrackItem},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{mpsc, watch};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Cursor {
    pub timestamp: i64,
    pub ordinal: i64,
}

#[derive(Clone)]
pub struct Observation {
    pub source: Arc<str>,
    pub cursor: Cursor,
    pub item: Option<TrackItem>,
}

pub struct Batch {
    pub last_id: i64,
    pub count: usize,
    pub payload: Vec<u8>,
}

#[derive(Clone)]
pub struct Store {
    worker: Arc<DbWorker>,
    max_events: usize,
    max_bytes: usize,
}

type DbJob = Box<dyn FnOnce(&mut Connection) + Send>;
struct DbWorker {
    sender: Option<mpsc::Sender<DbJob>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for DbWorker {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Store {
    pub fn open(config: &Config) -> Result<Self> {
        fs::create_dir_all(&config.state_dir)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(config.state_dir.join("agent.lock"))?;
        lock.try_lock()
            .map_err(|_| "STATE_DIR is already in use by another agent")?;
        let mut db = Connection::open(config.state_dir.join("agent.sqlite3"))?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, ordinal INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, payload BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK(id=1), events INTEGER NOT NULL, bytes INTEGER NOT NULL);
            INSERT OR IGNORE INTO usage VALUES (1,0,0);
            DROP TRIGGER IF EXISTS queue_added;
            DROP TRIGGER IF EXISTS queue_removed;
            PRAGMA cache_size=-512; PRAGMA mmap_size=0;")?;
        let identity = format!(
            "v1|{}|{}|{}|{:?}",
            config.node_ip, config.server_url, config.metrics_url, config.interfaces
        );
        let existing = Self::read_state::<String>(&db, "identity")?;
        if existing.as_ref().is_some_and(|old| old != &identity) {
            return Err("STATE_DIR belongs to a different node, endpoint or interface selection; use a separate directory".into());
        }
        Self::save_state(&db, "identity", &identity)?;
        // A dedicated bounded DB worker prevents slow DNS/filesystem jobs in
        // Tokio's blocking pool from stopping durable collection during outages.
        let (sender, mut receiver) = mpsc::channel::<DbJob>(16);
        let thread = std::thread::Builder::new()
            .name("agent-db".into())
            .spawn(move || {
                while let Some(job) = receiver.blocking_recv() {
                    job(&mut db);
                }
                drop(db);
                drop(lock);
            })?;
        Ok(Self {
            worker: Arc::new(DbWorker {
                sender: Some(sender),
                thread: Some(thread),
            }),
            max_events: config.queue_max_events,
            max_bytes: config.queue_max_bytes,
        })
    }

    pub async fn access<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.worker
            .sender
            .as_ref()
            .ok_or("database worker stopped")?
            .send(Box::new(move |db| {
                let _ = reply.send(operation(db));
            }))
            .await
            .map_err(|_| "database worker stopped")?;
        result.await.map_err(|_| "database worker failed")?
    }

    pub fn read_state<T: DeserializeOwned>(db: &Connection, key: &str) -> Result<Option<T>> {
        let value: Option<Vec<u8>> = db
            .query_row("SELECT value FROM state WHERE key=?", [key], |r| r.get(0))
            .optional()?;
        value
            .map(|value| rmp_serde::from_slice(&value).map_err(Into::into))
            .transpose()
    }

    pub fn save_state<T: Serialize>(db: &Connection, key: &str, value: &T) -> Result<()> {
        db.execute(
            "INSERT INTO state VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, rmp_serde::to_vec_named(value)?],
        )?;
        Ok(())
    }

    pub async fn cursor(&self, source: String, start: i64) -> Result<Cursor> {
        self.access(move |db| {
            db.execute(
                "INSERT OR IGNORE INTO cursors VALUES (?1,?2,0)",
                params![source, start],
            )?;
            Ok(db.query_row(
                "SELECT timestamp,ordinal FROM cursors WHERE source=?",
                [source],
                |r| {
                    Ok(Cursor {
                        timestamp: r.get(0)?,
                        ordinal: r.get(1)?,
                    })
                },
            )?)
        })
        .await
    }

    pub async fn enqueue(
        &self,
        observations: impl Into<Arc<Vec<Observation>>> + Send,
    ) -> Result<bool> {
        let observations = observations.into();
        let (max_events, max_bytes) = (self.max_events, self.max_bytes);
        self.access(move |db| {
            let tx = db.transaction()?;
            let mut cursors = HashMap::new();
            let mut payloads = Vec::new();
            let mut added_bytes = 0usize;
            {
                let mut lookup =
                    tx.prepare_cached("SELECT timestamp,ordinal FROM cursors WHERE source=?")?;
                for observation in observations.iter() {
                    let cursor = match cursors.entry(observation.source.clone()) {
                        std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                        std::collections::hash_map::Entry::Vacant(entry) => {
                            entry.insert(lookup.query_row([observation.source.as_ref()], |r| {
                                Ok(Cursor {
                                    timestamp: r.get(0)?,
                                    ordinal: r.get(1)?,
                                })
                            })?)
                        }
                    };
                    if observation.cursor <= *cursor {
                        continue;
                    }
                    *cursor = observation.cursor;
                    if let Some(item) = &observation.item {
                        let payload = rmp_serde::to_vec_named(item)?;
                        added_bytes += payload.len();
                        payloads.push(payload);
                    }
                }
            }
            let (events, bytes): (usize, usize) =
                tx.query_row("SELECT events,bytes FROM usage WHERE id=1", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
            if events + payloads.len() > max_events || bytes + added_bytes > max_bytes {
                return Ok(false);
            }
            {
                let mut insert = tx.prepare_cached("INSERT INTO queue(payload) VALUES (?)")?;
                for payload in &payloads {
                    insert.execute([payload])?;
                }
                let mut checkpoint = tx
                    .prepare_cached("UPDATE cursors SET timestamp=?1,ordinal=?2 WHERE source=?3")?;
                for (source, cursor) in cursors {
                    checkpoint.execute(params![
                        cursor.timestamp,
                        cursor.ordinal,
                        source.as_ref()
                    ])?;
                }
            }
            tx.execute(
                "UPDATE usage SET events=events+?1,bytes=bytes+?2 WHERE id=1",
                params![payloads.len(), added_bytes],
            )?;
            tx.commit()?;
            Ok(true)
        })
        .await
    }

    pub async fn batch(&self, limit: usize) -> Result<Option<Batch>> {
        self.access(move |db| {
            let limit = limit.clamp(1, 2000);
            let mut stmt = db.prepare_cached("SELECT id,payload FROM queue ORDER BY id LIMIT ?")?;
            let mut rows = stmt.query([limit])?;
            // Existing queue rows are complete named MessagePack maps. Concatenate
            // them behind an array16 header; no decode/re-encode or String clones.
            let mut payload = Vec::with_capacity((limit * 96).min(MAX_BATCH_BYTES));
            payload.extend_from_slice(&[0xdc, 0, 0]);
            let (mut last_id, mut count) = (0, 0);
            while let Some(row) = rows.next()? {
                let bytes = row.get_ref(1)?.as_blob()?;
                if payload.len() + bytes.len() > MAX_BATCH_BYTES {
                    if count == 0 {
                        return Err("stored event exceeds maximum batch size".into());
                    }
                    break;
                }
                payload.extend_from_slice(bytes);
                last_id = row.get(0)?;
                count += 1;
            }
            if count == 0 {
                return Ok(None);
            }
            payload[1..3].copy_from_slice(&(count as u16).to_be_bytes());
            Ok(Some(Batch {
                last_id,
                count,
                payload,
            }))
        })
        .await
    }

    pub async fn acknowledge(&self, last_id: i64) -> Result<()> {
        self.access(move |db| {
            let tx = db.transaction()?;
            let (events, bytes): (usize, usize) = tx.query_row(
                "SELECT count(*),COALESCE(sum(length(payload)),0) FROM queue WHERE id<=?",
                [last_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            tx.execute("DELETE FROM queue WHERE id<=?", [last_id])?;
            tx.execute(
                "UPDATE usage SET events=events-?1,bytes=bytes-?2 WHERE id=1",
                params![events, bytes],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }
}

pub async fn write_loop(
    store: Store,
    mut rx: mpsc::Receiver<Observation>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut buffer = Vec::with_capacity(512);
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let flush = tokio::select! {
            item = rx.recv() => match item { Some(item) => { buffer.push(item); buffer.len() >= 512 }, None => true },
            _ = interval.tick() => true,
        };
        if flush && !buffer.is_empty() {
            let batch = Arc::new(std::mem::replace(&mut buffer, Vec::with_capacity(512)));
            let mut announced = false;
            while !store.enqueue(batch.clone()).await? {
                if !announced {
                    eprintln!(
                        "queue full: collection paused until uploads succeed; Docker must retain unread logs"
                    );
                    announced = true;
                }
                if !crate::pause(Duration::from_millis(250), &mut stop).await {
                    return Ok(());
                }
            }
            buffer.clear();
        }
        if rx.is_closed() && rx.is_empty() && buffer.is_empty() {
            return Ok(());
        }
    }
}

#[cfg(test)]
pub fn test_config(path: &std::path::Path) -> Config {
    Config {
        server_url: "http://127.0.0.1:1/api/track_batch".parse().unwrap(),
        metrics_url: "http://127.0.0.1:1/api/node/metrics".parse().unwrap(),
        authorization: "Bearer test-token".parse().unwrap(),
        node_ip: "1.1.1.1".into(),
        batch_size: 100,
        targets: "test".into(),
        state_dir: path.into(),
        queue_max_events: 50_000,
        queue_max_bytes: 64 * 1024 * 1024,
        interfaces: vec![],
        docker_socket: "/var/run/docker.sock".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn database_is_independent_of_tokio_blocking_pool() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let store = Store::open(&test_config(dir.path())).unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, blocked) = std::sync::mpsc::channel();
            let task = tokio::task::spawn_blocking(move || {
                let _ = started.send(());
                let _ = blocked.recv();
            });
            ready.await.unwrap();
            let result =
                tokio::time::timeout(Duration::from_secs(1), store.cursor("source".into(), 0))
                    .await;
            release.send(()).unwrap();
            task.await.unwrap();
            assert!(result.unwrap().is_ok());
        });
    }
    #[tokio::test]
    async fn migrating_12_triggers_does_not_double_count_usage() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = test_config(dir.path());
        let store = Store::open(&cfg).unwrap();
        store.cursor("container/stdout".into(), 0).await.unwrap();
        store.enqueue(vec![record(1, "a".into())]).await.unwrap();
        store.access(|db| { db.execute_batch("CREATE TRIGGER queue_added AFTER INSERT ON queue BEGIN UPDATE usage SET events=events+1, bytes=bytes+length(NEW.payload) WHERE id=1; END; CREATE TRIGGER queue_removed AFTER DELETE ON queue BEGIN UPDATE usage SET events=events-1,bytes=bytes-length(OLD.payload) WHERE id=1; END;")?; Ok(()) }).await.unwrap();
        drop(store);
        let store = Store::open(&cfg).unwrap();
        store.enqueue(vec![record(2, "b".into())]).await.unwrap();
        let events: usize = store
            .access(|db| Ok(db.query_row("SELECT events FROM usage", [], |r| r.get(0))?))
            .await
            .unwrap();
        assert_eq!(events, 2);
        let batch = store.batch(500).await.unwrap().unwrap();
        store.acknowledge(batch.last_id).await.unwrap();
        let usage: (usize, usize) = store
            .access(|db| {
                Ok(db.query_row("SELECT events,bytes FROM usage", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?)
            })
            .await
            .unwrap();
        assert_eq!(usage, (0, 0));
    }
    fn record(n: i64, domain: String) -> Observation {
        Observation {
            source: "container/stdout".into(),
            cursor: Cursor {
                timestamp: n,
                ordinal: 1,
            },
            item: Some(TrackItem {
                ip: "8.8.8.8".into(),
                domain,
            }),
        }
    }
    #[tokio::test]
    async fn restart_preserves_queue_and_cursor_and_ack_deletes_only_sent_rows() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = test_config(dir.path());
        let store = Store::open(&cfg).unwrap();
        assert!(Store::open(&cfg).is_err());
        store.cursor("container/stdout".into(), 0).await.unwrap();
        store.enqueue(vec![record(1, "a".into())]).await.unwrap();
        let batch = store.batch(100).await.unwrap().unwrap();
        store.enqueue(vec![record(2, "b".into())]).await.unwrap();
        store.acknowledge(batch.last_id).await.unwrap();
        drop(store);
        let store = Store::open(&cfg).unwrap();
        assert_eq!(
            store
                .cursor("container/stdout".into(), 999)
                .await
                .unwrap()
                .timestamp,
            2
        );
        assert_eq!(store.batch(100).await.unwrap().unwrap().count, 1);
        store.enqueue(vec![record(2, "b".into())]).await.unwrap();
        assert_eq!(store.batch(100).await.unwrap().unwrap().count, 1);
    }
    #[tokio::test]
    async fn capacity_rolls_back_cursor_and_event_together() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = test_config(dir.path());
        cfg.queue_max_events = 1;
        let store = Store::open(&cfg).unwrap();
        store.cursor("container/stdout".into(), 0).await.unwrap();
        assert!(
            !store
                .enqueue(vec![record(1, "a".into()), record(2, "b".into())])
                .await
                .unwrap()
        );
        assert!(store.batch(100).await.unwrap().is_none());
        assert_eq!(
            store
                .cursor("container/stdout".into(), 0)
                .await
                .unwrap()
                .timestamp,
            0
        );
    }
    #[tokio::test]
    async fn batch_respects_bytes_and_count() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&test_config(dir.path())).unwrap();
        store.cursor("container/stdout".into(), 0).await.unwrap();
        store
            .enqueue(
                (1..=2100)
                    .map(|i| record(i, "x".repeat(512)))
                    .collect::<Vec<_>>(),
            )
            .await
            .unwrap();
        let batch = store.batch(9999).await.unwrap().unwrap();
        assert!(batch.count < 2000 && batch.payload.len() <= MAX_BATCH_BYTES);
        let items: Vec<TrackItem> = rmp_serde::from_slice(&batch.payload).unwrap();
        assert_eq!(items.len(), batch.count);
        assert_eq!(store.batch(17).await.unwrap().unwrap().count, 17);
    }
}
