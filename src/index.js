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
      SUM(CASE WHEN T2.CVE_ALM IN (1, 6) THEN T2.EXIST ELSE 0 END) AS EXISTENCIA,
      MAX(CASE WHEN T3.CVE_PRECIO = 1 THEN T3.PRECIO ELSE NULL END) AS PRECIO
    FROM
      INVE02 T1
    LEFT JOIN
      MULT02 T2 ON T1.CVE_ART = T2.CVE_ART
    LEFT JOIN
      PRECIO_X_PROD02 T3 ON T1.CVE_ART = T3.CVE_ART
    WHERE
      T1.STATUS = 'A'
    GROUP BY
      T1.CVE_ART,
      T1.DESCR,
      T1.LIN_PROD,
      T1.FCH_ULTCOM,
      T1.ULT_COSTO,
      T1.STATUS,
      T1.CVE_UNIDAD
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