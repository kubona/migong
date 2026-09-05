// IndexedDB owns completed data; only a bounded page is read into JS memory.
export async function fingerprint(value) {
  const normalize = (v) => v instanceof Set ? [...v].sort() : Array.isArray(v) ? v.map(normalize)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
  const bytes = new TextEncoder().encode(JSON.stringify(normalize(value)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}

export class RunStorage {
  static async open() {
    if (!globalThis.indexedDB) throw new Error('此浏览器无法保存断点，请使用本地启动器或支持IndexedDB的浏览器');
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('mwi-v039-runs', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('data');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new RunStorage(db);
  }
  constructor(db) { this.db = db; this.tail = Promise.resolve(); }
  get(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('data', 'readonly');
      const req = tx.objectStore('data').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  put(key, value) { return this.batch([[key, value]]); }
  batch(entries) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('data', 'readwrite');
      for (const [key, value] of entries) tx.objectStore('data').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error(`本机保存失败（可能空间不足），已停止以避免丢失记录：${tx.error?.message || '事务中断'}`));
      tx.onerror = () => {};
    });
  }
  serial(fn) {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async *entries(prefix, pageSize = 64) {
    let after = null;
    while (true) {
      const rows = await new Promise((resolve, reject) => {
        const tx = this.db.transaction('data', 'readonly');
        const range = IDBKeyRange.bound(after ?? prefix, prefix + '\uffff', after !== null, false);
        const req = tx.objectStore('data').openCursor(range);
        const page = [];
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || page.length >= pageSize) { resolve(page); return; }
          page.push([cursor.key, cursor.value]); cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
      if (!rows.length) return;
      for (const row of rows) yield row;
      after = rows.at(-1)[0];
    }
  }
  async begin(identity, settings, resume = false) {
    const latest = await this.get('latest');
    if (resume) {
      if (!latest || latest.identity !== identity) throw new Error('断点与本次角色、游戏数据、计算文件或设置不一致，请恢复原数据和设置');
      this.id = latest.id;
      return latest;
    }
    this.id = crypto.randomUUID();
    const meta = { id: this.id, identity, settings, startedAt: new Date().toISOString(), elapsed: 0, complete: false };
    await this.batch([['latest', meta], [this.key('meta'), meta]]);
    return meta;
  }
  key(suffix) { return `${this.id}/${suffix}`; }
  async updateMeta(changes) {
    return this.serial(async () => {
      const meta = { ...await this.get(this.key('meta')), ...changes };
      await this.batch([[this.key('meta'), meta], ['latest', meta]]);
    });
  }
  async *values(prefix) { for await (const [, value] of this.entries(this.key(prefix))) yield value; }
  async clearAll() {
    await this.tail;
    return new Promise((resolve,reject)=>{
      const tx=this.db.transaction('data','readwrite');tx.objectStore('data').clear();
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });
  }
}

export async function runtimeFingerprint() {
  const paths = ['engine/src_worker_js.bundle.js', 'engine/vendors-heap.bundle.js',
    ...['exhaustive-optimizer','component-planner','engine-adapter','player-dto','classifier','equipment-presets',
      'ability-selection-rules','data-model','fixed-skill-options','result-retention','stored-audit','run-storage','statistics','app',
      'learning-optimizer','learning-library','learning-model','learning-worker','sequential-confidence','optimizer'].map(n => `js/${n}.js`)];
  return fingerprint(await Promise.all(paths.map(async path => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`无法核对计算文件：${path}`);
    return [path, await fingerprint(await response.text())];
  })));
}

export async function learningRuntimeFingerprint() {
  const paths = ['engine/src_worker_js.bundle.js', 'engine/vendors-heap.bundle.js', 'js/engine-adapter.js', 'js/player-dto.js', 'js/learning-model.js'];
  return fingerprint(await Promise.all(paths.map(async path => {
    const response = await fetch(path); if (!response.ok) throw new Error(`无法核对战斗文件：${path}`);
    return [path, await fingerprint(await response.text())];
  })));
}
