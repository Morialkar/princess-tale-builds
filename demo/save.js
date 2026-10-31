// The local game's save in a browser: an SQLite database in sql.js (sql-wasm.js beside the page), kept in the
// browser's IndexedDB. openSave() reads it back (or starts an empty one: the game's server fills it at its first
// login) and sets window.ptSQL, which internal/sqljs (the game's "sqlite" driver) sends its statements to. Every
// change is written back to IndexedDB a moment later, once no transaction is open. Under node (the driver's tests)
// it is only the bridge.
(function () {
  const DB = "princess-tale", STORE = "save", KEY = "server.db";

  function idb() {
    return new Promise((ok, ko) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
  }

  async function read() {
    const d = await idb();
    return new Promise((ok, ko) => {
      const r = d.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => ok(r.result || null);
      r.onerror = () => ko(r.error);
    });
  }

  async function write(bytes, key = KEY) {
    const d = await idb();
    return new Promise((ok, ko) => {
      const t = d.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(bytes, key);
      t.oncomplete = () => ok();
      t.onerror = () => ko(t.error);
    });
  }

  function toBase64(b) {
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromBase64(s) {
    const t = atob(s), b = new Uint8Array(t.length);
    for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
    return b;
  }

  // A parameter as internal/sqljs encodes it: {"i": digits} an integer past 2^53, {"b": base64} bytes.
  function param(v) {
    if (v !== null && typeof v === "object") return v.i !== undefined ? BigInt(v.i) : fromBase64(v.b);
    return v;
  }

  // A column's value as internal/sqljs reads it: integers in full, blobs as {"b": base64}.
  function column(v) {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Uint8Array) return '{"b":"' + toBase64(v) + '"}';
    if (typeof v === "number" && !isFinite(v)) return "null";
    return JSON.stringify(v);
  }

  // placeholders is how many ?s a statement has, outside its strings, quoted names and comments.
  function placeholders(sql) {
    let n = 0;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (c === "'" || c === '"' || c === "`" || c === "[") {
        const end = sql.indexOf(c === "[" ? "]" : c, i + 1);
        i = end < 0 ? sql.length : end;
      } else if (c === "-" && sql[i + 1] === "-") {
        const end = sql.indexOf("\n", i);
        i = end < 0 ? sql.length : end;
      } else if (c === "/" && sql[i + 1] === "*") {
        const end = sql.indexOf("*/", i + 2);
        i = end < 0 ? sql.length : end + 1;
      } else if (c === "?") {
        n++;
      }
    }
    return n;
  }

  // A save file of the apps (.ptsave, docs/ACCOUNT_BACKUP.md) is a gzip.
  function isGzip(b) {
    return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
  }

  // A valid save starts with SQLite's header.
  function isSave(b) {
    const head = "SQLite format 3\0";
    if (b.length < 100) return false;
    for (let i = 0; i < head.length; i++) if (b[i] !== head.charCodeAt(i)) return false;
    return true;
  }

  // rollback makes a save in WAL mode (the native game's, header bytes 18 and 19 at 2) one in rollback mode: a
  // database in memory has no WAL, and a save copied alone has no -wal file beside it.
  function rollback(b) {
    if (b.length > 19 && b[18] === 2) b[18] = b[19] = 1;
    return b;
  }

  // bridge is internal/sqljs's way into the database db: run runs a statement (several at once, without parameters
  // or rows) and is its JSON (the columns, the rows, the changes and the last row id, or the error); changed is called
  // after a statement that changed something, open is how many transactions (savepoints) are open.
  function bridge(db, changed) {
    let depth = 0;
    const total = () => db.exec("SELECT total_changes()")[0].values[0][0];
    return {
      open: () => depth,
      run(sql, params, rows) {
        try {
          const values = JSON.parse(params).map(param);
          const head = sql.trimStart().slice(0, 9).toUpperCase();
          if (head === "SAVEPOINT") depth++;
          else if (head.startsWith("RELEASE")) depth--;
          const before = total();
          let cols = [], out = [];
          if (rows) {
            const st = db.prepare(sql);
            try {
              st.bind(values);
              cols = st.getColumnNames();
              while (st.step()) out.push("[" + st.get(null, { useBigInt: true }).map(column).join(",") + "]");
            } finally {
              st.free();
            }
          } else {
            // Each statement takes the next parameters, as many as its ?s (modernc.org/sqlite's way).
            let k = 0;
            for (const st of db.iterateStatements(sql)) {
              try {
                const n = placeholders(st.getSQL());
                st.bind(values.slice(k, k + n));
                k += n;
                while (st.step());
              } finally {
                st.free();
              }
            }
          }
          let changes = 0, last = 0;
          if (total() !== before) {
            changes = db.getRowsModified();
            last = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
            changed();
          }
          return '{"cols":' + JSON.stringify(cols) + ',"rows":[' + out.join(",") + '],"changes":' + changes +
            ',"last":' + last + "}";
        } catch (e) {
          return JSON.stringify({ error: String(e && e.message ? e.message : e) });
        }
      },
    };
  }

  if (typeof module !== "undefined") module.exports = { bridge }; // internal/sqljs/testdata/run.js
  if (typeof window === "undefined") return;

  window.openSave = async function () {
    const SQL = await initSqlJs({ locateFile: (f) => f });
    const saved = await read();
    const db = new SQL.Database(saved ? rollback(new Uint8Array(saved)) : undefined);
    let timer = null, frozen = false;
    const b = bridge(db, schedule);

    function flush() {
      timer = null;
      if (b.open() > 0) return schedule();
      write(db.export()).catch((e) => console.warn("save:", e));
    }

    function schedule() {
      if (timer === null && !frozen) timer = setTimeout(flush, 500);
    }

    // Every database the game opens is this one: the name is the file it would be natively.
    window.ptSQL = { run: (name, sql, params, rows) => b.run(sql, params, rows) };

    // Leaving the page writes what is not yet written.
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && timer !== null && !frozen && b.open() === 0) {
        clearTimeout(timer);
        flush();
      }
    });

    // The page's menu: the save as the apps' file (.ptsave) and back, the database itself, start over.
    window.ptSave = {
      async exportFile() {
        if (!window.ptBackup) throw new Error("le jeu n'a pas fini de charger");
        const f = await ptBackup.export();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([f.bytes], { type: "application/octet-stream" }));
        a.download = f.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
      // importFile loads a .ptsave (the apps' export: through the game's own Backup/Import, the save it replaces
      // kept in IndexedDB as "before-import") or a .db (the database itself), then starts the game again.
      async importFile(file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (isSave(bytes)) return this.load(file);
        if (!isGzip(bytes)) throw new Error("ce fichier n'est pas une sauvegarde (.ptsave ou .db)");
        if (!window.ptBackup) throw new Error("le jeu n'a pas fini de charger");
        await write(db.export(), "before-import");
        let got;
        try {
          got = await ptBackup.import(bytes);
        } catch (e) {
          throw new Error(e === "refused" ? "cette sauvegarde n'a pas pu être chargée (fichier abîmé ou d'un autre jeu)" : String(e));
        }
        clearTimeout(timer);
        frozen = true;
        await write(db.export());
        alert("Sauvegarde chargée : " + got.nickname + ", niveau " + got.level + ".");
        location.reload();
      },
      download() {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([db.export()], { type: "application/vnd.sqlite3" }));
        a.download = "princess-tale-save.db";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
      async load(file) {
        const b = new Uint8Array(await file.arrayBuffer());
        if (!isSave(b)) throw new Error("ce fichier n'est pas une sauvegarde (base SQLite)");
        rollback(b);
        clearTimeout(timer);
        frozen = true; // nothing more is written from the database in memory
        await write(b);
        location.reload();
      },
      async reset() {
        clearTimeout(timer);
        frozen = true;
        await write(null);
        location.reload();
      },
    };
  };
})();
