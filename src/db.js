// src/db.js
const Firebird = require('node-firebird');
require('dotenv').config();

const options = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  role: null,
  charset: 'UTF8'
};

const pool = Firebird.pool(5, options); // El 5 es el tamaño del pool

module.exports = {
  query: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      pool.get((err, db) => {
        if (err) {
          console.error("Error al obtener la conexión del pool:", err);
          return reject(err);
        }

        db.query(sql, params, (err, result) => {
          db.detach(); // Importante: liberar la conexión al pool
          if (err) {
            console.error("Error al ejecutar la consulta:", err);
            return reject(err);
          }
          resolve(result);
        });
      });
    });
  }
};