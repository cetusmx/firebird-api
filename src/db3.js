// conexión a rosa quezada
const Firebird = require('node-firebird');
require('dotenv').config();

const options = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_DATABASE_EMP3, 
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  role: null,
  charset: 'UTF8'
};

const pool = Firebird.pool(5, options);

module.exports = {
  query: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      pool.get((err, db) => {
        if (err) {
          console.error("Error en conexión de Empresa 3:", err);
          return reject(err);
        }
        db.query(sql, params, (err, result) => {
          db.detach();
          if (err) {
            console.error("Error en query de Empresa 3:", err);
            return reject(err);
          }
          resolve(result);
        });
      });
    });
  }
};