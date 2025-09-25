// src/index.js
const express = require('express');
const db = require('./db');
require('dotenv').config();

const app = express();
const port = process.env.API_PORT || 3010;

// Middleware para parsear JSON en las solicitudes (aunque no lo necesitemos para solo lectura, es una buena práctica)
app.use(express.json());

// Endpoint de prueba
app.get('/', (req, res) => {
  res.send('API de solo lectura para Firebird está en funcionamiento!');
});

// Endpoint para obtener todos los productos
app.get('/productos', async (req, res) => {
  const sql = 'SELECT * FROM PRODUCTOS';
  try {
    const productos = await db.query(sql);
    res.json(productos);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar la base de datos.' });
  }
});

// Endpoint para obtener un producto por su ID
app.get('/productos/:id', async (req, res) => {
  const { id } = req.params;
  const sql = 'SELECT * FROM PRODUCTOS WHERE ID = ?';
  try {
    const producto = await db.query(sql, [id]);
    if (producto.length > 0) {
      res.json(producto[0]);
    } else {
      res.status(404).json({ message: 'Producto no encontrado.' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar la base de datos.' });
  }
});


// Endpoint para obtener información detallada de productos
app.get('/productos-detallado', async (req, res) => {
  const sql = `
    SELECT
      T1.CVE_ART,
      T1.DESCR,
      T1.LIN_PROD,
      T1.FCH_ULTCOM,
      T1.ULT_COSTO,
      T1.STATUS,
      T1.CVE_UNIDAD,
      -- Usamos COALESCE para asegurar que si no hay registros de stock, EXISTENCIA sea 0 en lugar de NULL
      COALESCE(T2_AGGR.EXISTENCIA, 0) AS EXISTENCIA, 
      T3_AGGR.PRECIO
    FROM
      INVE01 T1
    LEFT JOIN
      -- SUBQUERY 1: Agregación de Existencias (MULT02)
      (
        SELECT
          CVE_ART,
          SUM(EXIST) AS EXISTENCIA
        FROM
          MULT02
        WHERE
          CVE_ALM IN (1, 6) -- Filtrar SOLO almacenes 1 y 6
        GROUP BY
          CVE_ART
      ) T2_AGGR ON T1.CVE_ART = T2_AGGR.CVE_ART
    LEFT JOIN
      -- SUBQUERY 2: Extracción de Precio Específico (PRECIO_X_PROD02)
      (
        SELECT
          CVE_ART,
          PRECIO
        FROM
          PRECIO_X_PROD02
        WHERE
          CVE_PRECIO = 1 -- Filtrar SOLO el precio tipo 1
      ) T3_AGGR ON T1.CVE_ART = T3_AGGR.CVE_ART
    WHERE
      T1.STATUS = 'A'
    ORDER BY
      T1.CVE_ART;
  `;

  try {
    const productos = await db.query(sql);
    res.json(productos);
  } catch (error) {
    console.error('Error al ejecutar la consulta detallada:', error);
    res.status(500).json({ error: 'Error al consultar la base de datos para obtener los detalles de los productos.' });
  }
});


// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});