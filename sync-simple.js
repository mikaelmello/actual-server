let { existsSync, readFileSync } = require('fs');
let { join } = require('path');
let { openDatabase } = require('./db');
let config = require('./load-config');

let actual = require('@actual-app/api');
let merkle = actual.internal.merkle;
let SyncPb = actual.internal.SyncProtoBuf;
let Timestamp = actual.internal.timestamp.default;

function getGroupDb(groupId) {
  let path = join(config.userFiles, `${groupId}.sqlite`);
  let needsInit = !existsSync(path);

  let db = openDatabase(path);

  if (needsInit) {
    let sql = readFileSync(join(__dirname, 'sql/messages.sql'), 'utf8');
    db.exec(sql);
  }

  return db;
}

function addMessages(db, messages) {
  let returnValue;
  db.transaction(() => {
    let trie = getMerkle(db);

    if (messages.length > 0) {
      for (let msg of messages) {
        let info = db.mutate(
          `INSERT OR IGNORE INTO messages_binary (timestamp, is_encrypted, content)
             VALUES (?, ?, ?)`,
          [
            msg.getTimestamp(),
            msg.getIsencrypted() ? 1 : 0,
            Buffer.from(msg.getContent())
          ]
        );

        if (info.changes > 0) {
          trie = merkle.insert(trie, Timestamp.parse(msg.getTimestamp()));
        }
      }
    }

    trie = merkle.prune(trie);

    db.mutate(
      'INSERT INTO messages_merkles (id, merkle) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET merkle = ?',
      [JSON.stringify(trie), JSON.stringify(trie)]
    );

    returnValue = trie;
  });

  return returnValue;
}

function getMerkle(db) {
  let rows = db.all('SELECT * FROM messages_merkles');

  if (rows.length > 0) {
    return JSON.parse(rows[0].merkle);
  } else {
    // No merkle trie exists yet (first sync of the app), so create a
    // default one.
    return {};
  }
}

function sync(messages, since, groupId) {
  let db = getGroupDb(groupId);
  let newMessages = db.all(
    `SELECT * FROM messages_binary
         WHERE timestamp > ?
         ORDER BY timestamp`,
    [since]
  );

  let trie = addMessages(db, messages);

  db.close();

  return {
    trie,
    newMessages: newMessages.map((msg) => {
      const envelopePb = new SyncPb.MessageEnvelope();
      envelopePb.setTimestamp(msg.timestamp);
      envelopePb.setIsencrypted(msg.is_encrypted);
      envelopePb.setContent(msg.content);
      return envelopePb;
    })
  };
}

module.exports = { sync };
