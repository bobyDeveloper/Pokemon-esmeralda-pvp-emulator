const DATABASE_NAME = 'emerald-pvp';
const STORE_NAME = 'saves';
const ACCESS_STORE = 'local-access';
let databasePromise;

export async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Abre la aplicación desde HTTPS o localhost para verificar ROMs y partidas de forma segura.');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'romId' });
        if (!request.result.objectStoreNames.contains(ACCESS_STORE)) request.result.createObjectStore(ACCESS_STORE);
      };
      request.onerror = () => reject(new Error('No se pudo abrir el almacenamiento local.', { cause: request.error }));
      request.onblocked = () => reject(new Error('Cierra otras pestañas de Emerald PVP para abrir el almacenamiento.'));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = undefined;
        };
        resolve(database);
      };
    }).catch(error => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

async function transaction(mode, operation, storeName = STORE_NAME) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    // Request success alone does not mean that a write has committed.
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(new Error(
      'No se pudo guardar la partida en este navegador. Exporta una copia .sav.',
      { cause: transaction.error },
    ));
  });
}

export const saveStorage = {
  async get(romId) {
    const record = await transaction('readonly', store => store.get(romId));
    if (!record) return null;
    if (!(record.bytes instanceof Uint8Array) || await sha256(record.bytes) !== record.checksum) {
      const error = new Error('La partida local no supera la verificación de integridad. No se ha sobrescrito. Importa una copia .sav válida.');
      error.code = 'SAVE_INTEGRITY';
      throw error;
    }
    return { bytes: record.bytes, updatedAt: record.updatedAt };
  },

  async put(romId, name, bytes) {
    const copy = bytes.slice();
    const updatedAt = Date.now();
    const checksum = await sha256(copy);
    await transaction('readwrite', store => store.put({ romId, name, bytes: copy, checksum, updatedAt }));
    return updatedAt;
  },
};

// Only an explicitly authorized file handle/identity; never the ROM's bytes.
export const romAccess = {
  get: () => transaction('readonly', store => store.get('last'), ACCESS_STORE),
  put: record => transaction('readwrite', store => store.put(record, 'last'), ACCESS_STORE),
  remove: () => transaction('readwrite', store => store.delete('last'), ACCESS_STORE),
};
