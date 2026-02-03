// src/index.js
require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const db = require('./db');
const db3 = require('./db3');
const cors = require('cors');

const app = express();
const port = process.env.API_PORT || 3010;

const corsOptions = {
  origin: 'http://localhost:5173',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', // Permite todos los métodos necesarios
  credentials: true, // Si necesitas enviar cookies o cabeceras de autorización
};

app.use(cors(corsOptions));

// Middleware para parsear JSON en las solicitudes (aunque no lo necesitemos para solo lectura, es una buena práctica)
app.use(express.json());
app.use(morgan());


// Constantes de mapeo de almacenes (Sucursales)
const ALMACENES = {
  '1': 'Durango',
  //'3': 'Fresnillo',
  '5': 'Mazatlán',
  '6': 'Zacatecas',
  '7': 'Querétaro',
  '10': 'Fresnillo'
};

/**
 * Transforma las columnas pivotadas de existencia (ALM_X_EXIST)
 * en el objeto 'existencias' requerido y limpia las columnas originales.
 * @param {Array<Object>} data Resultados crudos de la consulta SQL.
 * @returns {Array<Object>} Datos transformados.
 */
function processExistencias(data) {
  return data.map(item => {
    const existencias = {};

    Object.keys(ALMACENES).forEach(key => {
      const rawKey = `ALM_${key}_EXIST`;
      // Asigna el valor o 0 si es NULL/missing, y limpia el campo temporal
      existencias[ALMACENES[key]] = item[rawKey] ? parseFloat(item[rawKey]) : 0;
      delete item[rawKey];
    });

    item.existencias = existencias;
    return item;
  });
}

async function enrichWithUltimoCosto(data) {
  if (!data || data.length === 0) return data;

  // Solo tomamos los IDs de los 10 registros actuales
  const ids = data.map(item => item.CVE_ART.trim());
  const placeholders = ids.map(() => '?').join(',');

  // Consultamos MINVE02 solo para esos 10 productos
  const sqlMinve = `
        SELECT CVE_ART, CLAVE_CLPV, COSTO, NUM_MOV
        FROM MINVE02
        WHERE CVE_CPTO = 1 AND CVE_ART IN (${placeholders})
        ORDER BY NUM_MOV DESC
    `;

  try {
    const movimientos = await db.query(sqlMinve, ids);

    // Mapa para guardar solo el movimiento más reciente de cada artículo
    const movMap = {};
    movimientos.forEach(m => {
      const art = m.CVE_ART.trim();
      if (!movMap[art]) {
        movMap[art] = {
          proveedor: m.CLAVE_CLPV ? m.CLAVE_CLPV.trim() : '',
          costo: m.COSTO || 0
        };
      }
    });

    // Inyectamos los datos en el array original de 10 registros
    return data.map(item => {
      const info = movMap[item.CVE_ART.trim()];
      return {
        ...item,
        ULTIMO_PROVEEDOR: info ? info.proveedor : '',
        ULT_COSTO: info ? info.costo : 0
      };
    });
  } catch (error) {
    console.error("Error en MINVE02:", error);
    return data.map(item => ({ ...item, ULTIMO_PROVEEDOR: '', ULT_COSTO: 0 }));
  }
}

/**
 * Obtiene los precios de la tabla correspondiente (02 o 03) según la SUCURSAL
 * y la lista_precios solicitada.
 */
async function enrichWithPrecios(data, sucursal, listaPrecios) {
  if (!data || data.length === 0) return data;
  const ids = data.map(item => item.CVE_ART.trim());
  const placeholders = ids.map(() => '?').join(',');
  const cveLista = listaPrecios ? listaPrecios.toString() : '4';

  // Usamos toString() para que '3' == 3
  const esSucursal3 = sucursal && sucursal.toString() === '3';
  const connection = esSucursal3 ? db3 : db;
  const table = esSucursal3 ? 'PRECIO_X_PROD03' : 'PRECIO_X_PROD02';

  const sql = `SELECT TRIM(CVE_ART) AS ART, PRECIO FROM ${table} WHERE TRIM(CVE_PRECIO) = CAST(? AS VARCHAR(10)) AND CVE_ART IN (${placeholders})`;

  try {
    const results = await connection.query(sql, [cveLista, ...ids]);
    const priceMap = {};
    results.forEach(r => {
      priceMap[r.ART] = r.PRECIO;
    });

    return data.map(item => ({
      ...item,
      PRECIO: priceMap[item.CVE_ART.trim()] !== undefined ? priceMap[item.CVE_ART.trim()] : 0.00
    }));
  } catch (error) {
    console.error(`Error en enrichWithPrecios (${table}) para lista ${cveLista}:`, error.message);
    return data.map(item => ({ ...item, PRECIO: 0.00 }));
  }
}


// Endpoint de prueba
app.get('/', (req, res) => {
  res.send('API de solo lectura para Firebird está en funcionamiento!');
});

// src/index.js (Servidor 'Z' - Nuevo Endpoint /existencia-alm/:clave)

// Endpoint para obtener la existencia de un producto por almacén
app.get('/existenciaalm/:clave', async (req, res) => {
  const { clave } = req.params;

  // Consulta SQL para obtener todos los registros de MULT02 para una clave específica
  const sql = `
    SELECT
      CVE_ART,
      CVE_ALM,
      EXIST
    FROM
      MULT02
    WHERE
      CVE_ART = ?
    ORDER BY
      CVE_ALM;
  `;

  try {
    // Nota: El conector node-firebird usa un array para los parámetros [clave]
    const existencias = await db.query(sql, [clave]);

    if (existencias.length === 0) {
      // Devolvemos un 404 si el producto no tiene registros de existencia en MULT02
      return res.status(404).json({ error: 'No se encontraron registros de existencia para la clave de producto especificada.' });
    }

    // Devolvemos el array de existencias (una fila por almacén)
    res.json(existencias);
  } catch (error) {
    console.error('Error al ejecutar la consulta de existencia por almacén:', error);
    res.status(500).json({
      error: 'Error interno del servidor al consultar existencia por almacén.',
      detalles: error.message
    });
  }
});

// index.js (Nuevo Endpoint POST para existencias filtradas)

app.post('/existencias-masiva-filtrada', async (req, res) => {
  const claves = req.body.claves;

  if (!Array.isArray(claves) || claves.length === 0) {
    return res.status(400).json({ error: 'Se requiere un arreglo no vacío de claves de producto.' });
  }

  // 1. Crear una cadena de placeholders '?' para la cláusula IN
  // Esto previene inyecciones SQL (SQL Injection).
  const placeholders = claves.map(() => '?').join(', ');

  // 2. Consulta SQL con doble filtro: por las claves enviadas Y por almacén (1 y 6)
  const sql = `
    SELECT
      CVE_ART,
      CVE_ALM,
      EXIST
    FROM
      MULT02
    WHERE
      CVE_ART IN (${placeholders}) AND CVE_ALM IN (1, 6)
    ORDER BY
      CVE_ART, CVE_ALM;
  `;

  try {
    // 3. Ejecutar la consulta pasando el arreglo de claves como parámetros
    const existencias = await db.query(sql, claves);
    res.json(existencias);
  } catch (error) {
    console.error('Error al ejecutar la consulta de existencias masivas filtradas:', error);
    res.status(500).json({
      error: 'Error al consultar la base de datos para obtener las existencias filtradas.',
      detalles: error.message
    });
  }
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

// Endpoint consolidado para obtener todos los datos de un solo producto, este
//es el que se utiliza para ProductDetailPage
app.get('/inventariocompleto/:clave', async (req, res) => {
  const { clave } = req.params;

  const sql = `
    SELECT
      T1.CVE_ART,
      T1.DESCR,
      T1.FCH_ULTCOM,
      T1.ULT_COSTO,
      COALESCE(T2_AGGR.EXISTENCIA, 0) AS EXISTENCIA, -- Existencia de subconsulta
      T3_AGGR.PRECIO -- Precio de subconsulta
    FROM
      INVE02 T1
    LEFT JOIN
      -- SUBQUERY 1: AGREGACIÓN DE EXISTENCIAS (Garantiza 1 fila por producto)
      (
        SELECT
          CVE_ART,
          SUM(EXIST) AS EXISTENCIA
        FROM
          MULT02
        WHERE
          CVE_ALM IN (1, 6)
        GROUP BY
          CVE_ART
      ) T2_AGGR ON T1.CVE_ART = T2_AGGR.CVE_ART
    LEFT JOIN
      -- SUBQUERY 2: EXTRACCIÓN DE PRECIO (Garantiza 1 fila por producto)
      (
        SELECT
          CVE_ART,
          PRECIO
        FROM
          PRECIO_X_PROD02
        WHERE
          CVE_PRECIO = 1
      ) T3_AGGR ON T1.CVE_ART = T3_AGGR.CVE_ART
    WHERE
      T1.CVE_ART = ?  -- FILTRO POR CLAVE ÚNICA
    GROUP BY
      T1.CVE_ART,
      T1.DESCR,
      T1.FCH_ULTCOM,
      T1.ULT_COSTO,
      T2_AGGR.EXISTENCIA,
      T3_AGGR.PRECIO;
  `;

  try {
    const resultado = await db.query(sql, [clave]);

    // ... (rest of the logic remains the same)
    if (resultado.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado en la base de datos de Firebird.' });
    }

    res.json(resultado[0]);
  } catch (error) {
    // ... (error handling)
    console.error('Error al ejecutar la consulta consolidada por clave (corregida):', error);
    res.status(500).json({
      error: 'Error interno del servidor al obtener datos consolidados.',
      detalles: error.message
    });
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
      INVE02 T1
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

// Nuevo Endpoint para obtener solo precios
app.get('/precios', async (req, res) => {
  // Opcional: Implementa paginación aquí también si tienes muchos precios
  const limit = parseInt(req.query.limit) || 1000;
  const offset = parseInt(req.query.offset) || 0;

  const sql = `
    SELECT
      CVE_ART,
      PRECIO
    FROM
      PRECIO_X_PROD02
    WHERE
      CVE_PRECIO = 1
    ORDER BY
      CVE_ART;
  `;
  /* const sql = `
    SELECT FIRST ${limit} SKIP ${offset}
      CVE_ART,
      PRECIO
    FROM
      PRECIO_X_PROD02
    WHERE
      CVE_PRECIO = 1
    ORDER BY
      CVE_ART;
  `; */

  try {
    const precios = await db.query(sql);
    res.json(precios);
  } catch (error) {
    console.error('Error al ejecutar la consulta de precios:', error);
    // Dejamos un mensaje detallado para ayudar en la depuración si falla
    res.status(500).json({ error: 'Error al consultar la base de datos para obtener los precios.', detalles: error.message });
  }
});

app.get('/familias', async (req, res) => {
  // Lista de familias a excluir
  const excluir = [
    'ACC. ANCLAJE', 'ADHES', 'AJUSTADOR', 'ANILLO', 'BARRA', 'BUJE',
    'COMP. SIST. HIDR.', 'COMPRESOR', 'CONEXIONES', 'COPA', 'COPA PISTON',
    'DRING', 'EMBOLOS', 'ESTOPEROS', 'ESTUC', 'HERRAM', 'KIT', 'LUBRIC',
    'MANGUERAS', 'SELLO MECANICO', 'SUJETADOR', 'TAPAS', 'TUBO'
  ];

  // Generamos los placeholders (?, ?, ...) para la consulta
  const placeholders = excluir.map(() => '?').join(', ');

  const sql = `
    SELECT DISTINCT
      CAMPLIB22 AS FAMILIA
    FROM
      INVE_CLIB02
    WHERE
      CAMPLIB22 IS NOT NULL 
      AND CAMPLIB22 <> ''
      AND UPPER(TRIM(CAMPLIB22)) NOT IN (${placeholders})
    ORDER BY
      FAMILIA;
  `;

  try {
    // Pasamos el array de exclusión como parámetros para mayor seguridad
    const familias = await db.query(sql, excluir);

    res.json(familias);
  } catch (error) {
    console.error('Error al ejecutar la consulta de familias filtradas:', error);
    res.status(500).json({
      error: 'Error interno del servidor al obtener las familias.',
      detalles: error.message
    });
  }
});

// Nuevo Endpoint para obtener las existencias de MULT02
app.get('/existencias', async (req, res) => {
  const sql = `
    SELECT
      CVE_ART,
      CVE_ALM,
      EXIST
    FROM
      MULT02
    WHERE
      CVE_ALM IN (1, 6)
    ORDER BY
      CVE_ART, CVE_ALM;
  `;

  try {
    const existencias = await db.query(sql);
    res.json(existencias);
  } catch (error) {
    console.error('Error al ejecutar la consulta de existencias:', error);
    // Devolvemos el error detallado para ayudar en la depuración
    res.status(500).json({ error: 'Error al consultar la base de datos para obtener las existencias.', detalles: error.message });
  }
});

// Nuevo Endpoint para obtener la información base de INVE01 (DESCR, FCH_ULTCOM, ULT_COSTO)
app.get('/inventario', async (req, res) => {
  const sql = `
    SELECT
      CVE_ART,
      DESCR,
      FCH_ULTCOM,
      ULT_COSTO,
      UNI_MED
    FROM
      INVE02 
    WHERE
      STATUS = 'A'
    ORDER BY
      CVE_ART;
  `;

  try {
    const inventario = await db.query(sql);
    res.json(inventario);
  } catch (error) {
    console.error('Error al ejecutar la consulta de inventario base:', error);
    res.status(500).json({
      error: 'Error al consultar la base de datos para obtener el inventario base.',
      detalles: error.message
    });
  }
});

// Endpoint para obtener información de productos con sus claves alternas y proveedores
app.get('/clavesalternas', async (req, res) => {
  // Consulta SQL para combinar INVE02, CVES_ALTER02, PROV02 y AHORA INVE_CLIB02
  const sql = `
    SELECT
      T1.CVE_ART,         -- Clave de Producto (INVE02)
      T1.DESCR,           -- Descripción (INVE02)
      T1.UNI_MED,         -- Unidad de Medida (INVE02)
      T1.FCH_ULTCOM,      -- Fecha Última Compra (INVE02)
      T1.ULT_COSTO,       -- Último Costo (INVE02)
      T2.CVE_ALTER,       -- Clave Alterna (CVES_ALTER02)
      T2.CVE_CLPV,        -- Clave de Proveedor (CVES_ALTER02)
      T3.NOMBRE,          -- Nombre del Proveedor (PROV02)
      -- Nuevos campos de INVE_CLIB02 T4
      T4.CAMPLIB1 AS DIAM_INT,
      T4.CAMPLIB2 AS DIAM_EXT,
      T4.CAMPLIB3 AS ALTURA,
      T4.CAMPLIB7 AS SECCION,
      T4.CAMPLIB15 AS CLA_SYR,
      T4.CAMPLIB16 AS CLA_LC,
      T4.CAMPLIB17 AS SIST_MED,
      T4.CAMPLIB19 AS DESC_ECOMM,
      T4.CAMPLIB21 AS GENERO,
      T4.CAMPLIB22 AS FAMILIA
    FROM
      INVE02 T1 -- Tabla Principal: Productos
    LEFT JOIN
      CVES_ALTER02 T2 -- JOIN 1: Claves Alternas
      ON T1.CVE_ART = T2.CVE_ART
    LEFT JOIN
      PROV02 T3 -- JOIN 2: Proveedores
      ON T2.CVE_CLPV = T3.CLAVE
    LEFT JOIN
      INVE_CLIB02 T4 -- <--- ¡NUEVO JOIN para campos libres!
      ON T1.CVE_ART = T4.CVE_PROD
    WHERE
      T2.TIPO = 'P' -- Filtro requerido: Solo claves alternas de TIPO "P" (Proveedor)
    ORDER BY
      T1.CVE_ART, T2.CVE_ALTER;
  `;

  try {
    const resultados = await db.query(sql);
    res.json(resultados);
  } catch (error) {
    console.error('Error al ejecutar la consulta de claves alternas:', error);
    res.status(500).json({
      error: 'Error interno del servidor al obtener las claves alternas.',
      detalles: error.message
    });
  }
});

app.get('/clavesalternas/search', async (req, res) => {
  const { query, SUCURSAL } = req.query;
  const searchTerm = query ? query.toUpperCase().trim() : '';
  const likeTerm = `%${searchTerm}%`;

  // CORRECCIÓN 1: Manejar SUCURSAL como String y asegurar el tipo para Firebird
  const cvePrecio = SUCURSAL ? SUCURSAL.toString() : '1';

  if (!searchTerm) {
    return res.status(400).json({ error: 'Debes proporcionar un término de búsqueda.' });
  }

  // CORRECCIÓN 2: Consulta optimizada con LEFT JOINS y CASTs para evitar el error -303
  const sql = `
        SELECT 
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO, T1.LIN_PROD,
            T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, T4.CAMPLIB13 AS PERFIL, 
            T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA, T4.CAMPLIB28 AS COLOCACION,
            COALESCE(MAX(T5.PRECIO), 0.00) AS PRECIO, 
            MAX(CASE WHEN TRIM(T2.CVE_CLPV) = '3' THEN T2.CVE_ALTER ELSE NULL END) AS PROV1, 
            MAX(CASE WHEN TRIM(T2.CVE_CLPV) = '35' THEN T2.CVE_ALTER ELSE NULL END) AS PROV2,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 1 THEN T6.EXIST ELSE NULL END), 0) AS ALM_1_EXIST,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 3 THEN T6.EXIST ELSE NULL END), 0) AS ALM_3_EXIST,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 5 THEN T6.EXIST ELSE NULL END), 0) AS ALM_5_EXIST,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 6 THEN T6.EXIST ELSE NULL END), 0) AS ALM_6_EXIST,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 7 THEN T6.EXIST ELSE NULL END), 0) AS ALM_7_EXIST
        FROM INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        -- Colocamos el filtro de precio en el ON y usamos CAST para evitar truncation
        LEFT JOIN PRECIO_X_PROD02 T5 ON (T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = CAST(? AS VARCHAR(10)))
        LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
        WHERE 
            UPPER(T1.CVE_ART) LIKE CAST(? AS VARCHAR(100)) OR 
            UPPER(T1.DESCR) LIKE CAST(? AS VARCHAR(100)) OR 
            UPPER(COALESCE(T2.CVE_ALTER, '')) LIKE CAST(? AS VARCHAR(100)) OR
            UPPER(COALESCE(T4.CAMPLIB19, '')) LIKE CAST(? AS VARCHAR(100))
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
        ORDER BY T1.CVE_ART;
    `;

  try {
    // Ejecutar consulta con los parámetros limpios
    let dataResult = await db.query(sql, [cvePrecio, likeTerm, likeTerm, likeTerm, likeTerm]);

    if (dataResult.length > 0) {
      const articulosIds = dataResult.map(item => item.CVE_ART.trim());
      const sqlEmp3 = `
                SELECT TRIM(CVE_ART) AS ART, EXIST 
                FROM MULT03 
                WHERE CVE_ALM = 3 AND CVE_ART IN (${articulosIds.map(() => '?').join(',')})
            `;

      try {
        const resEmp3 = await db3.query(sqlEmp3, articulosIds);
        const existenciaEmp3Map = {};
        resEmp3.forEach(row => { existenciaEmp3Map[row.ART] = row.EXIST; });

        dataResult = dataResult.map(item => ({
          ...item,
          ALM_10_EXIST: existenciaEmp3Map[item.CVE_ART.trim()] || 0
        }));
      } catch (err3) {
        dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: 0 }));
      }
    }

    dataResult = processExistencias(dataResult);
    res.json(dataResult);

  } catch (error) {
    console.error('Error en search corregido:', error);
    res.status(500).json({ error: 'Error interno del servidor.', detalles: error.message });
  }
});

app.get('/clavesalternas/search2', async (req, res) => {
  const { query, SUCURSAL } = req.query;
  const searchTerm = query ? query.toUpperCase().trim() : '';
  const cvePrecio = SUCURSAL ? SUCURSAL.toString() : '1';

  if (!searchTerm) return res.status(400).json({ error: 'Query requerido' });

  const sql = `
        SELECT 
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO, T1.LIN_PROD,
            T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, T4.CAMPLIB13 AS PERFIL, 
            T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA, T4.CAMPLIB28 AS COLOCACION,
            COALESCE(MAX(T5.PRECIO), 0.00) AS PRECIO,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 1 THEN T6.EXIST ELSE NULL END), 0) AS ALM_1_EXIST,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 3 THEN T6.EXIST ELSE NULL END), 0) AS ALM_3_EXIST,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 5 THEN T6.EXIST ELSE NULL END), 0) AS ALM_5_EXIST,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 6 THEN T6.EXIST ELSE NULL END), 0) AS ALM_6_EXIST,
            COALESCE(MAX(CASE WHEN T6.CVE_ALM = 7 THEN T6.EXIST ELSE NULL END), 0) AS ALM_7_EXIST
        FROM INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        LEFT JOIN PRECIO_X_PROD02 T5 ON (T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = CAST(? AS VARCHAR(10)))
        LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
        WHERE 
            T1.CVE_ART = CAST(? AS VARCHAR(100)) OR
            UPPER(T2.CVE_ALTER) = CAST(? AS VARCHAR(100)) OR
            UPPER(T1.DESCR) LIKE CAST(? AS VARCHAR(100))
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
        ORDER BY T1.CVE_ART
    `;

  try {
    const likeTerm = `%${searchTerm}%`;
    let dataResult = await db.query(sql, [cvePrecio, searchTerm, searchTerm, likeTerm]);

    // Enriquecer con Empresa 3
    if (dataResult.length > 0) {
      const ids = dataResult.map(item => item.CVE_ART.trim());
      const sql3 = `SELECT TRIM(CVE_ART) AS ART, EXIST FROM MULT03 WHERE CVE_ALM = 3 AND CVE_ART IN (${ids.map(() => '?').join(',')})`;
      const res3 = await db3.query(sql3, ids);
      const map3 = {};
      res3.forEach(r => map3[r.ART] = r.EXIST);
      dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: map3[item.CVE_ART.trim()] || 0 }));
    }

    dataResult = processExistencias(dataResult);
    res.json(dataResult); // Estructura original: devuelve el array directamente
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* app.get('/clavesalternas/filter-ranges', async (req, res) => {
  const { lista_precios, SUCURSAL, familia, diam_int_min, diam_int_max, diam_ext_min, diam_ext_max, altura_min, altura_max, limit, offset } = req.query;
  //SUCURSAL es el número de almacén
  const cvePrecio = SUCURSAL ? SUCURSAL.toString() : '1';
  const numLimit = parseInt(limit) || 10;
  const numOffset = parseInt(offset) || 0;

  let whereClauses = ["1=1"];
  let params = [cvePrecio];

  // Filtros de rangos
  const rangeFilters = [
    { min: diam_int_min, max: diam_int_max, col: 'T4.CAMPLIB1' },
    { min: diam_ext_min, max: diam_ext_max, col: 'T4.CAMPLIB2' },
    { min: altura_min, max: altura_max, col: 'T4.CAMPLIB3' }
  ];

  rangeFilters.forEach(filter => {
    if (filter.min || filter.max) {
      const dbNum = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${filter.col}), ''), '0'), ',', '.') AS NUMERIC(15, 4))`;
      if (filter.min) {
        whereClauses.push(`${dbNum} >= CAST(? AS NUMERIC(15, 4))`);
        params.push(parseFloat(filter.min.replace(',', '.')));
      }
      if (filter.max) {
        whereClauses.push(`${dbNum} <= CAST(? AS NUMERIC(15, 4))`);
        params.push(parseFloat(filter.max.replace(',', '.')));
      }
    }
  });

  if (familia) {
    whereClauses.push(`UPPER(TRIM(COALESCE(T4.CAMPLIB22, ''))) = UPPER(TRIM(?))`);
    params.push(familia);
  }

  const whereString = `WHERE ${whereClauses.join(' AND ')}`;

  // CONSULTA 1: Total de registros para la paginación
  const countSql = `
        SELECT COUNT(DISTINCT T1.CVE_ART) AS TOTAL 
        FROM INVE02 T1 
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD 
        ${whereString}
    `;

  // CONSULTA 2: Datos base (Solo los 10 registros de la página actual)
  const dataSql = `
    SELECT FIRST ${numLimit} SKIP ${numOffset}
        T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, 
        T1.ULT_COSTO AS COSTO_PROM, T1.LIN_PROD,
        T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
        T4.CAMPLIB7 AS SECCION, T4.CAMPLIB13 AS PERFIL, 
        T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
        T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
        T4.CAMPLIB22 AS FAMILIA, T4.CAMPLIB28 AS COLOCACION,
        COALESCE(MAX(T5.PRECIO), 0.00) AS PRECIO, 
        COALESCE(MAX(CASE WHEN T6.CVE_ALM = 1 THEN T6.EXIST ELSE NULL END), 0) AS ALM_1_EXIST,
        -- SE ELIMINÓ ALM_3_EXIST DE AQUÍ
        COALESCE(MAX(CASE WHEN T6.CVE_ALM = 5 THEN T6.EXIST ELSE NULL END), 0) AS ALM_5_EXIST,
        COALESCE(MAX(CASE WHEN T6.CVE_ALM = 6 THEN T6.EXIST ELSE NULL END), 0) AS ALM_6_EXIST,
        COALESCE(MAX(CASE WHEN T6.CVE_ALM = 7 THEN T6.EXIST ELSE NULL END), 0) AS ALM_7_EXIST
    FROM INVE02 T1
    LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
    LEFT JOIN PRECIO_X_PROD02 T5 ON (T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = CAST(? AS VARCHAR(10)))
    LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
    ${whereString}
    GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18 -- Se mantiene igual si las columnas base no cambian
    ORDER BY T1.CVE_ART;
`;

  try {
    // Ejecutamos el conteo
    const countRes = await db.query(countSql, params.slice(1));
    const totalRecords = countRes[0]?.TOTAL || 0;

    // EJECUTAMOS dataSql (Asegúrate de que sea dataSql y no sql)
    let dataResult = await db.query(dataSql, params);

    // PASO 3: Enriquecer con MINVE02 (Solo los registros de la página)
    dataResult = await enrichWithUltimoCosto(dataResult);

    // PASO 4: Enriquecer con Almacén 10 (DB3)
    if (dataResult.length > 0) {
      const ids = dataResult.map(item => item.CVE_ART.trim());
      const sql3 = `SELECT TRIM(CVE_ART) AS ART, EXIST FROM MULT03 WHERE CVE_ALM = 3 AND CVE_ART IN (${ids.map(() => '?').join(',')})`;
      const res3 = await db3.query(sql3, ids);
      const map3 = {};
      res3.forEach(r => map3[r.ART] = r.EXIST);
      dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: map3[item.CVE_ART.trim()] || 0 }));
    }

    res.json({
      data: processExistencias(dataResult),
      pagination: {
        currentPage: Math.floor(numOffset / numLimit) + 1,
        totalPages: Math.ceil(totalRecords / numLimit),
        totalRecords,
        limit: numLimit
      }
    });
  } catch (error) {
    console.error("Error en filter-ranges:", error);
    res.status(500).json({ error: error.message });
  }
}); */

/* app.get('/clavesalternas/filter', async (req, res) => {
  const { lista_precios, SUCURSAL, familia, limit, offset } = req.query;
  const cvePrecio = SUCURSAL ? SUCURSAL.toString() : '1';

  const numLimit = parseInt(limit) || 10;
  const numOffset = parseInt(offset) || 0;

  let whereClauses = ["1=1"];
  let params = [cvePrecio];

  // Mapeo de campos dimensionales para filtros exactos
  const dimensionalFields = {
    diam_int: 'T4.CAMPLIB1',
    diam_ext: 'T4.CAMPLIB2',
    altura: 'T4.CAMPLIB3',
    seccion: 'T4.CAMPLIB7'
  };

  for (const key in dimensionalFields) {
    const val = req.query[key];
    if (val) {
      const numVal = parseFloat(val.replace(',', '.'));
      if (!isNaN(numVal)) {
        // Buscamos coincidencia exacta numérica
        const dbNum = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${dimensionalFields[key]}), ''), '0'), ',', '.') AS NUMERIC(15, 4))`;
        whereClauses.push(`ABS(${dbNum} - CAST(? AS NUMERIC(15, 4))) <= 0.001`);
        params.push(numVal);
      }
    }
  }

  if (familia) {
    whereClauses.push(`UPPER(TRIM(COALESCE(T4.CAMPLIB22, ''))) = UPPER(TRIM(?))`);
    params.push(familia);
  }

  const whereString = `WHERE ${whereClauses.join(' AND ')}`;

  try {
    // 1. Conteo para paginación
    const countSql = `SELECT COUNT(DISTINCT T1.CVE_ART) AS TOTAL FROM INVE02 T1 LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD ${whereString}`;
    const countRes = await db.query(countSql, params.slice(1));
    const totalRecords = countRes[0]?.TOTAL || 0;

    // 2. Consulta de datos base (Sin MINVE02 para evitar lentitud)
    const sql = `
    SELECT FIRST ${numLimit} SKIP ${numOffset}
        T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, 
        T1.ULT_COSTO AS COSTO_PROM, 
        T1.LIN_PROD,
        T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
        T4.CAMPLIB7 AS SECCION, T4.CAMPLIB13 AS PERFIL, 
        T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
        T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
        T4.CAMPLIB22 AS FAMILIA, T4.CAMPLIB28 AS COLOCACION,
        COALESCE(MAX(T5.PRECIO), 0.00) AS PRECIO, 
        COALESCE(MAX(CASE WHEN T6.CVE_ALM = 1 THEN T6.EXIST ELSE NULL END), 0) AS ALM_1_EXIST,
        -- SE ELIMINÓ ALM_3_EXIST DE AQUÍ
        COALESCE(MAX(CASE WHEN T6.CVE_ALM = 5 THEN T6.EXIST ELSE NULL END), 0) AS ALM_5_EXIST,
        COALESCE(MAX(CASE WHEN T6.CVE_ALM = 6 THEN T6.EXIST ELSE NULL END), 0) AS ALM_6_EXIST,
        COALESCE(MAX(CASE WHEN T6.CVE_ALM = 7 THEN T6.EXIST ELSE NULL END), 0) AS ALM_7_EXIST
    FROM INVE02 T1
    LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
    LEFT JOIN PRECIO_X_PROD02 T5 ON (T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = CAST(? AS VARCHAR(10)))
    LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
    ${whereString}
    GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
    ORDER BY T1.CVE_ART;
`;

    let dataResult = await db.query(sql, params);

    // 3. Enriquecer con el último costo y proveedor (MINVE02)
    dataResult = await enrichWithUltimoCosto(dataResult);

    // 4. Enriquecer con Almacén 10 (DB3)
    if (dataResult.length > 0) {
      const ids = dataResult.map(item => item.CVE_ART.trim());
      const sql3 = `SELECT TRIM(CVE_ART) AS ART, EXIST FROM MULT03 WHERE CVE_ALM = 3 AND CVE_ART IN (${ids.map(() => '?').join(',')})`;
      const res3 = await db3.query(sql3, ids);
      const map3 = {};
      res3.forEach(r => map3[r.ART] = r.EXIST);
      dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: map3[item.CVE_ART.trim()] || 0 }));
    }

    res.json({
      data: processExistencias(dataResult),
      pagination: {
        currentPage: Math.floor(numOffset / numLimit) + 1,
        totalPages: Math.ceil(totalRecords / numLimit),
        totalRecords,
        limit: numLimit
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}); */

app.get('/clavesalternas/filter-ranges', async (req, res) => {
  const { lista_precios, SUCURSAL, familia, diam_int_min, diam_int_max, diam_ext_min, diam_ext_max, altura_min, altura_max, limit, offset } = req.query;
  const numLimit = parseInt(limit) || 10;
  const numOffset = parseInt(offset) || 0;

  let whereClauses = ["1=1"];
  let params = []; // LIMPIEZA: Ya no iniciamos con cvePrecio

  // Filtros de rangos
  const rangeFilters = [
    { min: diam_int_min, max: diam_int_max, col: 'T4.CAMPLIB1' },
    { min: diam_ext_min, max: diam_ext_max, col: 'T4.CAMPLIB2' },
    { min: altura_min, max: altura_max, col: 'T4.CAMPLIB3' }
  ];

  rangeFilters.forEach(filter => {
    if (filter.min || filter.max) {
      const dbNum = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${filter.col}), ''), '0'), ',', '.') AS NUMERIC(15, 4))`;
      if (filter.min) {
        whereClauses.push(`${dbNum} >= CAST(? AS NUMERIC(15, 4))`);
        params.push(parseFloat(filter.min.replace(',', '.')));
      }
      if (filter.max) {
        whereClauses.push(`${dbNum} <= CAST(? AS NUMERIC(15, 4))`);
        params.push(parseFloat(filter.max.replace(',', '.')));
      }
    }
  });

  if (familia) {
    whereClauses.push(`UPPER(TRIM(COALESCE(T4.CAMPLIB22, ''))) = UPPER(TRIM(?))`);
    params.push(familia);
  }

  const whereString = `WHERE ${whereClauses.join(' AND ')}`;

  try {
    // 1. Conteo (params ya no requiere .slice)
    const countSql = `SELECT COUNT(DISTINCT T1.CVE_ART) AS TOTAL FROM INVE02 T1 LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD ${whereString}`;
    const countRes = await db.query(countSql, params);
    const totalRecords = countRes[0]?.TOTAL || 0;

    // 2. Consulta de datos (ELIMINADO JOIN T5 y ALM_3_EXIST)
    const dataSql = `
      SELECT FIRST ${numLimit} SKIP ${numOffset}
          T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, 
          T1.ULT_COSTO AS COSTO_PROM, T1.LIN_PROD,
          T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
          T4.CAMPLIB7 AS SECCION, T4.CAMPLIB13 AS PERFIL, 
          T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
          T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
          T4.CAMPLIB22 AS FAMILIA, T4.CAMPLIB28 AS COLOCACION,
          COALESCE(MAX(CASE WHEN T6.CVE_ALM = 1 THEN T6.EXIST ELSE NULL END), 0) AS ALM_1_EXIST,
          COALESCE(MAX(CASE WHEN T6.CVE_ALM = 5 THEN T6.EXIST ELSE NULL END), 0) AS ALM_5_EXIST,
          COALESCE(MAX(CASE WHEN T6.CVE_ALM = 6 THEN T6.EXIST ELSE NULL END), 0) AS ALM_6_EXIST,
          COALESCE(MAX(CASE WHEN T6.CVE_ALM = 7 THEN T6.EXIST ELSE NULL END), 0) AS ALM_7_EXIST
      FROM INVE02 T1
      LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
      LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
      ${whereString}
      GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
      ORDER BY T1.CVE_ART;
    `;

    let dataResult = await db.query(dataSql, params);

    // 3. Enriquecer con precios (Ruteo DB2/DB3)
    dataResult = await enrichWithPrecios(dataResult, SUCURSAL, lista_precios);

    // 4. Enriquecer con costo y existencia Almacén 10
    dataResult = await enrichWithUltimoCosto(dataResult);
    if (dataResult.length > 0) {
      const ids = dataResult.map(item => item.CVE_ART.trim());
      const sql3 = `SELECT TRIM(CVE_ART) AS ART, EXIST FROM MULT03 WHERE CVE_ALM = 3 AND CVE_ART IN (${ids.map(() => '?').join(',')})`;
      const res3 = await db3.query(sql3, ids);
      const map3 = {};
      res3.forEach(r => map3[r.ART] = r.EXIST);
      dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: map3[item.CVE_ART.trim()] || 0 }));
    }

    res.json({
      data: processExistencias(dataResult),
      pagination: {
        currentPage: Math.floor(numOffset / numLimit) + 1,
        totalPages: Math.ceil(totalRecords / numLimit),
        totalRecords,
        limit: numLimit
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/clavesalternas/filter', async (req, res) => {
  const { lista_precios, SUCURSAL, familia, limit, offset } = req.query;
  const numLimit = parseInt(limit) || 10;
  const numOffset = parseInt(offset) || 0;

  let whereClauses = ["1=1"];
  let params = []; // LIMPIEZA: Ya no iniciamos con cvePrecio

  const dimensionalFields = { diam_int: 'T4.CAMPLIB1', diam_ext: 'T4.CAMPLIB2', altura: 'T4.CAMPLIB3', seccion: 'T4.CAMPLIB7' };

  for (const key in dimensionalFields) {
    const val = req.query[key];
    if (val) {
      const numVal = parseFloat(val.replace(',', '.'));
      if (!isNaN(numVal)) {
        const dbNum = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${dimensionalFields[key]}), ''), '0'), ',', '.') AS NUMERIC(15, 4))`;
        whereClauses.push(`ABS(${dbNum} - CAST(? AS NUMERIC(15, 4))) <= 0.001`);
        params.push(numVal);
      }
    }
  }

  if (familia) {
    whereClauses.push(`UPPER(TRIM(COALESCE(T4.CAMPLIB22, ''))) = UPPER(TRIM(?))`);
    params.push(familia);
  }

  const whereString = `WHERE ${whereClauses.join(' AND ')}`;

  try {
    const countSql = `SELECT COUNT(DISTINCT T1.CVE_ART) AS TOTAL FROM INVE02 T1 LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD ${whereString}`;
    const countRes = await db.query(countSql, params);
    const totalRecords = countRes[0]?.TOTAL || 0;

    const sql = `
      SELECT FIRST ${numLimit} SKIP ${numOffset}
          T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, 
          T1.ULT_COSTO AS COSTO_PROM, T1.LIN_PROD,
          T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
          T4.CAMPLIB7 AS SECCION, T4.CAMPLIB13 AS PERFIL, 
          T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
          T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
          T4.CAMPLIB22 AS FAMILIA, T4.CAMPLIB28 AS COLOCACION,
          COALESCE(MAX(CASE WHEN T6.CVE_ALM = 1 THEN T6.EXIST ELSE NULL END), 0) AS ALM_1_EXIST,
          COALESCE(MAX(CASE WHEN T6.CVE_ALM = 5 THEN T6.EXIST ELSE NULL END), 0) AS ALM_5_EXIST,
          COALESCE(MAX(CASE WHEN T6.CVE_ALM = 6 THEN T6.EXIST ELSE NULL END), 0) AS ALM_6_EXIST,
          COALESCE(MAX(CASE WHEN T6.CVE_ALM = 7 THEN T6.EXIST ELSE NULL END), 0) AS ALM_7_EXIST
      FROM INVE02 T1
      LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
      LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
      ${whereString}
      GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
      ORDER BY T1.CVE_ART;
    `;

    let dataResult = await db.query(sql, params);

    // Enriquecer con precios (Ruteo DB2/DB3)
    dataResult = await enrichWithPrecios(dataResult, SUCURSAL, lista_precios);

    // Enriquecer con el resto de datos
    dataResult = await enrichWithUltimoCosto(dataResult);
    if (dataResult.length > 0) {
      const ids = dataResult.map(item => item.CVE_ART.trim());
      const sql3 = `SELECT TRIM(CVE_ART) AS ART, EXIST FROM MULT03 WHERE CVE_ALM = 3 AND CVE_ART IN (${ids.map(() => '?').join(',')})`;
      const res3 = await db3.query(sql3, ids);
      const map3 = {};
      res3.forEach(r => map3[r.ART] = r.EXIST);
      dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: map3[item.CVE_ART.trim()] || 0 }));
    }

    res.json({
      data: processExistencias(dataResult),
      pagination: {
        currentPage: Math.floor(numOffset / numLimit) + 1,
        totalPages: Math.ceil(totalRecords / numLimit),
        totalRecords,
        limit: numLimit
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});