// ============================================================
//  Conexão com o SQL Server (pool reaproveitado)
// ============================================================
import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

const config = {
  server: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: String(process.env.DB_ENCRYPT).toLowerCase() === 'true',
    trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERT).toLowerCase() === 'true'
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

// Instância nomeada (ex.: SQLEXPRESS): usa instanceName e ignora a porta.
if (process.env.DB_INSTANCE) {
  config.options.instanceName = process.env.DB_INSTANCE;
  delete config.port;
}

let poolPromise = null;

export function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config).catch((err) => {
      poolPromise = null; // permite nova tentativa após falha
      throw err;
    });
  }
  return poolPromise;
}

// Helper: executa uma query com parâmetros nomeados.
// params = { nome: { type: sql.NVarChar, value: '...' }, ... }  ou  { nome: valor }
export async function query(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [key, val] of Object.entries(params)) {
    if (val && typeof val === 'object' && 'type' in val) {
      req.input(key, val.type, val.value);
    } else {
      req.input(key, val);
    }
  }
  return req.query(text);
}

export { sql };
