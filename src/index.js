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
    '3': 'Fresnillo',
    '5': 'Mazatlán',
    '6': 'Zacatecas',
    '7': 'Querétaro',
    '10': 'Fresnillo2'
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

/* app.get('/familias', async (req, res) => {
  const sql = `
    SELECT DISTINCT
      CAMPLIB22 AS FAMILIA
    FROM
      INVE_CLIB02
    WHERE
      CAMPLIB22 IS NOT NULL AND CAMPLIB22 <> ''
    ORDER BY
      FAMILIA;
  `;

  try {
    const familias = await db.query(sql);
    
    // Devolvemos la lista de familias únicas
    res.json(familias);
  } catch (error) {
    console.error('Error al ejecutar la consulta de familias únicas:', error);
    res.status(500).json({ 
        error: 'Error interno del servidor al obtener las familias.', 
        detalles: error.message 
    });
  }
}); */

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

/* app.get('/clavesalternas/search', async (req, res) => {
    const { query, SUCURSAL } = req.query;
    const searchTerm = query ? query.toUpperCase().trim() : '';
    const likeTerm = `%${searchTerm}%`;
    const cvePrecio = SUCURSAL ? parseInt(SUCURSAL) : 1;

    if (!searchTerm) {
        return res.status(400).json({ error: 'Debes proporcionar un término de búsqueda.' });
    }

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
            MAX(CASE WHEN T6.CVE_ALM = '1' THEN T6.EXIST ELSE NULL END) AS ALM_1_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '3' THEN T6.EXIST ELSE NULL END) AS ALM_3_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '5' THEN T6.EXIST ELSE NULL END) AS ALM_5_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '6' THEN T6.EXIST ELSE NULL END) AS ALM_6_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '7' THEN T6.EXIST ELSE NULL END) AS ALM_7_EXIST
        FROM INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        LEFT JOIN PRECIO_X_PROD02 T5 ON T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = ? 
        LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
        WHERE 
            UPPER(T1.CVE_ART) LIKE ? OR 
            UPPER(T1.DESCR) LIKE ? OR 
            UPPER(T2.CVE_ALTER) LIKE ? OR
            UPPER(T4.CAMPLIB19) LIKE ?
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
        ORDER BY T1.CVE_ART;
    `;

    try {
        // A. Obtener resultados de DB Principal
        let dataResult = await db.query(sql, [cvePrecio, likeTerm, likeTerm, likeTerm, likeTerm]);

        // B. Si hay resultados, enriquecer con la Empresa 3 (Fresnillo2)
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
                resEmp3.forEach(row => {
                    existenciaEmp3Map[row.ART] = row.EXIST;
                });

                // Inyectar existencia de Fresnillo2
                dataResult = dataResult.map(item => ({
                    ...item,
                    ALM_10_EXIST: existenciaEmp3Map[item.CVE_ART.trim()] || 0
                }));
            } catch (err3) {
                console.error("Error en búsqueda DB3:", err3);
                dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: 0 }));
            }
        }

        // C. Procesar y enviar
        dataResult = processExistencias(dataResult);
        res.json(dataResult);

    } catch (error) {
        console.error('Error en search:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
}); */

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

    console.log(`[SEARCH2] Iniciando búsqueda para: "${searchTerm}" en Sucursal: ${cvePrecio}`);

    if (!searchTerm) {
        return res.status(400).json({ error: 'Proporciona un término de búsqueda.' });
    }

    // Consulta ultra-plana para diagnóstico
    // Nota: Usamos CAST(? AS VARCHAR(100)) para evitar el error -303 de truncamiento
    const sql = `
        SELECT 
            T1.CVE_ART, 
            T1.DESCR, 
            T1.FCH_ULTCOM,
            T1.ULT_COSTO,
            COALESCE(T5.PRECIO, -1) AS DB_PRECIO,
            COALESCE(T6.EXIST, -1) AS DB_EXIST_ALM1,
            T2.CVE_ALTER AS DB_CLAVE_ALT,
            T2.TIPO AS DB_TIPO_ALT,
            T4.CAMPLIB22 AS DB_FAMILIA
        FROM INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON (T1.CVE_ART = T2.CVE_ART)
        LEFT JOIN INVE_CLIB02 T4 ON (T1.CVE_ART = T4.CVE_PROD)
        LEFT JOIN PRECIO_X_PROD02 T5 ON (T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = CAST(? AS VARCHAR(10)))
        LEFT JOIN MULT02 T6 ON (T1.CVE_ART = T6.CVE_ART AND T6.CVE_ALM = 1)
        WHERE 
            T1.CVE_ART = CAST(? AS VARCHAR(100)) OR
            T2.CVE_ALTER = CAST(? AS VARCHAR(100)) OR
            UPPER(T1.DESCR) LIKE CAST(? AS VARCHAR(100))
    `;

    const startTime = Date.now();

    try {
        const likeTerm = `%${searchTerm}%`;
        const params = [cvePrecio, searchTerm, searchTerm, likeTerm];
        
        console.log('[SEARCH2] Ejecutando SQL en DB Principal...');
        let dataResult = await db.query(sql, params);
        
        console.log(`[SEARCH2] Filas encontradas: ${dataResult.length}. Tiempo: ${Date.now() - startTime}ms`);

        // Diagnóstico: Si no hay resultados, imprimimos qué se buscó exactamente
        if (dataResult.length === 0) {
            console.log(`[SEARCH2] ADVERTENCIA: No se encontró nada para "${searchTerm}"`);
        } else {
            // Log del primer resultado para ver qué trae la DB realmente
            console.log('[SEARCH2] Muestra del primer resultado:', {
                CVE: dataResult[0].CVE_ART,
                DESC: dataResult[0].DESCR,
                ALT: dataResult[0].DB_CLAVE_ALT,
                TIPO: dataResult[0].DB_TIPO_ALT
            });
        }

        // Integración con Empresa 3 (Fresnillo2)
        if (dataResult.length > 0) {
            const ids = dataResult.map(item => item.CVE_ART.trim());
            const sql3 = `SELECT TRIM(CVE_ART) AS ART, EXIST FROM MULT03 WHERE CVE_ALM = 3 AND CVE_ART IN (${ids.map(() => '?').join(',')})`;
            
            try {
                const res3 = await db3.query(sql3, ids);
                const map3 = {};
                res3.forEach(r => map3[r.ART] = r.EXIST);
                dataResult = dataResult.map(item => ({ 
                    ...item, 
                    DB_EXIST_ALM10: map3[item.CVE_ART.trim()] !== undefined ? map3[item.CVE_ART.trim()] : 'N/A'
                }));
            } catch (e) {
                console.error('[SEARCH2] Error en DB3:', e.message);
                dataResult = dataResult.map(item => ({ ...item, DB_EXIST_ALM10: 'ERROR' }));
            }
        }

        res.json({
            meta: {
                query_busqueda: searchTerm,
                total: dataResult.length,
                ms: Date.now() - startTime
            },
            results: dataResult
        });

    } catch (error) {
        console.error('[SEARCH2] ERROR CRÍTICO:', error);
        res.status(500).json({ 
            error: error.message,
            sql_state: error.gdscode
        });
    }
});

/* app.get('/clavesalternas/filter-ranges', async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const { SUCURSAL } = req.query; 
    const cvePrecio = SUCURSAL ? parseInt(SUCURSAL) : 1; 

    // Definimos las dimensiones que SIEMPRE vienen en par min/max
    const dimensionalFields = {
        DIAM_INT: 'T4.CAMPLIB1',
        DIAM_EXT: 'T4.CAMPLIB2',
        ALTURA: 'T4.CAMPLIB3',
        SECCION: 'T4.CAMPLIB7'
    };

    // Otros filtros que siguen siendo de texto o búsqueda parcial
    const extraFilters = {
        FAMILIA: 'T4.CAMPLIB22',
        COLOCACION: 'T4.CAMPLIB28',
        LINEA: 'T1.LIN_PROD',
        PERFIL: 'T4.CAMPLIB13',
        SIST_MED: 'T4.CAMPLIB17'
    };
    
    let whereClauses = ["T2.TIPO = 'P'"];
    let params = [];

    // 1. Lógica de Rangos con BETWEEN para dimensiones
    for (const alias in dimensionalFields) {
        const column = dimensionalFields[alias];
        const lowerAlias = alias.toLowerCase();
        
        const valMin = req.query[`${lowerAlias}_min`];
        const valMax = req.query[`${lowerAlias}_max`];

        if (valMin !== undefined && valMax !== undefined) {
            // Convertimos el campo de la DB (texto con comas) a numérico para comparar
            const dbNum = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${column}), ''), '0'), ',', '.') AS NUMERIC(15, 5))`;
            
            whereClauses.push(`${dbNum} BETWEEN CAST(? AS NUMERIC(15, 5)) AND CAST(? AS NUMERIC(15, 5))`);
            params.push(parseFloat(valMin.replace(',', '.')));
            params.push(parseFloat(valMax.replace(',', '.')));
        }
    }

    // 2. Lógica para filtros extra (Texto)
    for (const alias in extraFilters) {
        const column = extraFilters[alias];
        const val = req.query[alias.toLowerCase()];
        if (val) {
            whereClauses.push(`UPPER(TRIM(${column})) LIKE ?`);
            params.push(`%${val.toUpperCase().trim()}%`);
        }
    }

    const whereString = `WHERE ${whereClauses.join(' AND ')}`;

    // Consulta de Datos (Incluyendo LIN_PROD, COLOCACION y Almacenes de Empresa 2)
    const dataSql = `
        SELECT FIRST ${limit} SKIP ${offset}
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO, T1.LIN_PROD,
            T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, T4.CAMPLIB13 AS PERFIL, 
            T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA, T4.CAMPLIB28 AS COLOCACION,
            COALESCE(MAX(T5.PRECIO), 0.00) AS PRECIO, 
            MAX(CASE WHEN TRIM(T2.CVE_CLPV) = '3' THEN T2.CVE_ALTER ELSE NULL END) AS PROV1, 
            MAX(CASE WHEN TRIM(T2.CVE_CLPV) = '35' THEN T2.CVE_ALTER ELSE NULL END) AS PROV2,
            MAX(CASE WHEN T6.CVE_ALM = '1' THEN T6.EXIST ELSE NULL END) AS ALM_1_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '3' THEN T6.EXIST ELSE NULL END) AS ALM_3_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '5' THEN T6.EXIST ELSE NULL END) AS ALM_5_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '6' THEN T6.EXIST ELSE NULL END) AS ALM_6_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '7' THEN T6.EXIST ELSE NULL END) AS ALM_7_EXIST
        FROM INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        LEFT JOIN PRECIO_X_PROD02 T5 ON T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = ? 
        LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
        ${whereString}
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
        ORDER BY T1.CVE_ART;
    `;

    // Consulta de Conteo para paginación
    const countSql = `
        SELECT COUNT(DISTINCT T1.CVE_ART) AS TOTAL_REGISTROS
        FROM INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        ${whereString};
    `;

    try {
        const countRes = await db.query(countSql, params);
        const totalRegistros = countRes[0].TOTAL_REGISTROS || 0;

        let dataResult = await db.query(dataSql, [cvePrecio, ...params]); 

        // 3. Enriquecimiento con Empresa 3 (Fresnillo2 - Almacén 3)
        if (dataResult.length > 0) {
            const ids = dataResult.map(item => item.CVE_ART.trim());
            const sql3 = `SELECT TRIM(CVE_ART) AS ART, EXIST FROM MULT03 WHERE CVE_ALM = 3 AND CVE_ART IN (${ids.map(() => '?').join(',')})`;
            
            try {
                const res3 = await db3.query(sql3, ids);
                const map3 = {};
                res3.forEach(r => map3[r.ART] = r.EXIST);
                dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: map3[item.CVE_ART.trim()] || 0 }));
            } catch (err3) {
                dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: 0 }));
            }
        }

        dataResult = processExistencias(dataResult);

        res.json({
            data: dataResult,
            pagination: {
                totalRecords: totalRegistros,
                totalPages: Math.ceil(totalRegistros / limit),
                currentPage: Math.floor(offset / limit) + 1,
                limit
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}); */


app.get('/clavesalternas/filter-ranges', async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const { SUCURSAL } = req.query; 
    const cvePrecio = SUCURSAL ? parseInt(SUCURSAL) : 1; 

    const dimensionalFields = {
        DIAM_INT: 'T4.CAMPLIB1',
        DIAM_EXT: 'T4.CAMPLIB2',
        ALTURA: 'T4.CAMPLIB3',
        SECCION: 'T4.CAMPLIB7'
    };

    const extraFilters = {
        FAMILIA: 'T4.CAMPLIB22',
        COLOCACION: 'T4.CAMPLIB28',
        LINEA: 'T1.LIN_PROD',
        PERFIL: 'T4.CAMPLIB13',
        SIST_MED: 'T4.CAMPLIB17'
    };
    
    let whereClauses = ["T2.TIPO = 'P'"];
    let params = [];

    // 1. Lógica de Rangos - Ajustada para ser más permisiva con valores vacíos en la DB
    for (const alias in dimensionalFields) {
        const column = dimensionalFields[alias];
        const lowerAlias = alias.toLowerCase();
        
        const valMin = req.query[`${lowerAlias}_min`];
        const valMax = req.query[`${lowerAlias}_max`];

        if (valMin !== undefined && valMax !== undefined) {
            // Usamos COALESCE '0' para que si el campo está vacío en la DB no rompa la comparación numérica
            const dbNum = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${column}), ''), '0'), ',', '.') AS NUMERIC(15, 5))`;
            
            whereClauses.push(`${dbNum} BETWEEN CAST(? AS NUMERIC(15, 5)) AND CAST(? AS NUMERIC(15, 5))`);
            params.push(parseFloat(valMin.replace(',', '.')));
            params.push(parseFloat(valMax.replace(',', '.')));
        }
    }

    for (const alias in extraFilters) {
        const column = extraFilters[alias];
        const val = req.query[alias.toLowerCase()];
        if (val) {
            whereClauses.push(`UPPER(TRIM(COALESCE(${column}, ''))) LIKE ?`);
            params.push(`%${val.toUpperCase().trim()}%`);
        }
    }

    const whereString = `WHERE ${whereClauses.join(' AND ')}`;

    // Consulta de Datos corregida
    // Agregamos COALESCE a FCH_ULTCOM y aseguramos que el GROUP BY sea sólido
    const dataSql = `
        SELECT FIRST ${limit} SKIP ${offset}
            T1.CVE_ART, 
            T1.DESCR, 
            T1.UNI_MED, 
            T1.FCH_ULTCOM, -- No se puede usar COALESCE aquí si quieres el objeto Date original, pero Firebird lo maneja bien
            T1.ULT_COSTO, 
            T1.LIN_PROD,
            T4.CAMPLIB1 AS DIAM_INT, 
            T4.CAMPLIB2 AS DIAM_EXT, 
            T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, 
            T4.CAMPLIB13 AS PERFIL, 
            T4.CAMPLIB15 AS CLA_SYR, 
            T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, 
            T4.CAMPLIB19 AS DESC_ECOMM, 
            T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA, 
            T4.CAMPLIB28 AS COLOCACION,
            COALESCE(MAX(T5.PRECIO), 0.00) AS PRECIO, 
            MAX(CASE WHEN TRIM(T2.CVE_CLPV) = '3' THEN T2.CVE_ALTER ELSE NULL END) AS PROV1, 
            MAX(CASE WHEN TRIM(T2.CVE_CLPV) = '35' THEN T2.CVE_ALTER ELSE NULL END) AS PROV2,
            MAX(CASE WHEN T6.CVE_ALM = '1' THEN T6.EXIST ELSE NULL END) AS ALM_1_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '3' THEN T6.EXIST ELSE NULL END) AS ALM_3_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '5' THEN T6.EXIST ELSE NULL END) AS ALM_5_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '6' THEN T6.EXIST ELSE NULL END) AS ALM_6_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '7' THEN T6.EXIST ELSE NULL END) AS ALM_7_EXIST
        FROM INVE02 T1
        INNER JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        LEFT JOIN PRECIO_X_PROD02 T5 ON T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = CAST(? AS VARCHAR(10))
        LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
        ${whereString}
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
        ORDER BY T1.CVE_ART;
    `;

    const countSql = `
        SELECT COUNT(DISTINCT T1.CVE_ART) AS TOTAL_REGISTROS
        FROM INVE02 T1
        INNER JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        ${whereString};
    `;

    try {
        const countRes = await db.query(countSql, params);
        const totalRegistros = countRes[0].TOTAL_REGISTROS || 0;

        let dataResult = await db.query(dataSql, [cvePrecio, ...params]); 

        if (dataResult.length > 0) {
            const ids = dataResult.map(item => item.CVE_ART.trim());
            const sql3 = `SELECT TRIM(CVE_ART) AS ART, EXIST FROM MULT03 WHERE CVE_ALM = 3 AND CVE_ART IN (${ids.map(() => '?').join(',')})`;
            
            try {
                const res3 = await db3.query(sql3, ids);
                const map3 = {};
                res3.forEach(r => map3[r.ART] = r.EXIST);
                dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: map3[item.CVE_ART.trim()] || 0 }));
            } catch (err3) {
                dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: 0 }));
            }
        }

        dataResult = processExistencias(dataResult);

        res.json({
            data: dataResult,
            pagination: {
                totalRecords: totalRegistros,
                totalPages: Math.ceil(totalRegistros / limit),
                currentPage: Math.floor(offset / limit) + 1,
                limit
            }
        });
    } catch (error) {
        console.error("Error en filter-ranges:", error);
        res.status(500).json({ error: error.message });
    }
});


// Endpoint para búsqueda y filtrado avanzado con paginación
// Recibe: ?familia=X&diam_int=Y&limit=10&offset=0&SUCURSAL=3
/* app.get('/clavesalternas/filter', async (req, res) => {
    
    // 1. Configuración de Paginación y SUCURSAL
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const { SUCURSAL } = req.query; 
    const cvePrecio = SUCURSAL ? parseInt(SUCURSAL) : 1; 
    
    // Tolerancia (Epsilon) para comparar campos numéricos (NUMERIC(15, 5))
    const NUMERIC_TOLERANCE = 0.00001; 

    // 2. Definición de Parámetros de Filtrado
    const filterMap = {
        FAMILIA: 'T4.CAMPLIB22',
        DIAM_INT: 'T4.CAMPLIB1',
        DIAM_EXT: 'T4.CAMPLIB2',
        ALTURA: 'T4.CAMPLIB3',
        SECCION: 'T4.CAMPLIB7',
        PERFIL: 'T4.CAMPLIB13', 
        SIST_MED: 'T4.CAMPLIB17',
    };

    // Campos que deben ser tratados como NÚMEROS (para CAST a NUMERIC)
    const numericDimensionalFields = ['T4.CAMPLIB1', 'T4.CAMPLIB2', 'T4.CAMPLIB3', 'T4.CAMPLIB7'];
    
    let whereClauses = [];
    let params = [];
    
    whereClauses.push("T2.TIPO = 'P'");

    // 3. Construcción Dinámica de la Cláusula WHERE
    for (const alias in filterMap) {
        // FIX: Se define 'column' al inicio del loop para evitar el ReferenceError
        const column = filterMap[alias]; 
        let queryValue = req.query[alias.toLowerCase()]; 

        if (queryValue) {
            queryValue = queryValue.replace(/\+/g, ' ').trim(); 
            
            if (queryValue === '') continue; 

            // La variable 'column' ya está definida arriba
            
            // --- Lógica para Campos NUMÉRICOS (Comparación con Tolerancia) ---
            if (numericDimensionalFields.includes(column)) {
                
                const cleanNumericValue = parseFloat(queryValue.replace(',', '.'));
                
                if (isNaN(cleanNumericValue)) continue; 

                const dbColumnExpression = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${column}), ''), '0'), ',', '.') AS NUMERIC(15, 5))`;
                
                // Comparación por tolerancia para campos decimales
                whereClauses.push(`ABS(${dbColumnExpression} - CAST(? AS NUMERIC(15, 5))) <= ${NUMERIC_TOLERANCE}`);
                params.push(cleanNumericValue); 

            } else {
                // --- Lógica para Campos de TEXTO (incluye PERFIL) ---
                
                const upperQueryValue = queryValue.toUpperCase();
                const likeTerm = `%${upperQueryValue}%`;

                const dbColumnExpression = `UPPER(TRIM(${column}))`;

                whereClauses.push(`${dbColumnExpression} LIKE CAST(? AS VARCHAR(255))`);
                params.push(likeTerm);
            }
        }
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // 4. Consulta de CONTEO (Utiliza solo los parámetros de filtro)
    const countSql = `
        SELECT
            COUNT(DISTINCT T1.CVE_ART) AS TOTAL_REGISTROS
        FROM
            INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN PROV02 T3 ON T2.CVE_CLPV = T3.CLAVE
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        ${whereString};
    `;
    
    // 5. Consulta de DATOS (Paginada y Consolidada)
    const dataSql = `
        SELECT FIRST ${limit} SKIP ${offset}
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO,
            T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, 
            T4.CAMPLIB13 AS PERFIL, 
            T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA,
            
            -- FIX DE PRECIO: COALESCE(MAX()) y TRIM en el JOIN
            COALESCE(MAX(T5.PRECIO), 0.00) AS PRECIO, 
            
            -- PIVOT: Clave alterna del Proveedor '3' (PROV1)
            MAX(CASE 
                WHEN TRIM(T2.CVE_CLPV) = '3' 
                THEN T2.CVE_ALTER 
                ELSE NULL 
            END) AS PROV1, 
            
            -- PIVOT: Clave alterna del Proveedor '35' (PROV2)
            MAX(CASE 
                WHEN TRIM(T2.CVE_CLPV) = '35' 
                THEN T2.CVE_ALTER 
                ELSE NULL 
            END) AS PROV2,
            
            -- PIVOT: Existencias por Almacén (T6)
            MAX(CASE WHEN T6.CVE_ALM = '1' THEN T6.EXIST ELSE NULL END) AS ALM_1_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '3' THEN T6.EXIST ELSE NULL END) AS ALM_3_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '5' THEN T6.EXIST ELSE NULL END) AS ALM_5_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '6' THEN T6.EXIST ELSE NULL END) AS ALM_6_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '7' THEN T6.EXIST ELSE NULL END) AS ALM_7_EXIST
            
        FROM
            INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN PROV02 T3 ON T2.CVE_CLPV = T3.CLAVE
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        LEFT JOIN PRECIO_X_PROD02 T5
            -- FIX: Se agrega TRIM() a T5.CVE_PRECIO para manejar el padding de Firebird
            ON T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = ? 
        LEFT JOIN MULT02 T6
            ON T1.CVE_ART = T6.CVE_ART
        --
        ${whereString}
        
        -- Agrupamos por todos los campos de T1 y T4 (sin T5.PRECIO, que es agregado)
        GROUP BY
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO,
            T4.CAMPLIB1, T4.CAMPLIB2, T4.CAMPLIB3, T4.CAMPLIB7, T4.CAMPLIB13, T4.CAMPLIB15, 
            T4.CAMPLIB16, T4.CAMPLIB17, T4.CAMPLIB19, T4.CAMPLIB21, T4.CAMPLIB22
            
        ORDER BY
            T1.CVE_ART;
    `;

    try {
        // Ejecutar CONTEO
        const countResult = await db.query(countSql, params);
        const totalRegistros = countResult[0].TOTAL_REGISTROS || 0;

        // Manejo de 404
        if (totalRegistros === 0 && Object.keys(req.query).some(key => key !== 'limit' && key !== 'offset')) {
            return res.status(404).json({ message: 'No se encontraron resultados que coincidan con los criterios de filtro.' });
        }

        // Ejecutar DATOS: cvePrecio DEBE ir al inicio del array de parámetros
        let dataResult = await db.query(dataSql, [cvePrecio, ...params]); 
        
        // Post-procesamiento para transformar las existencias
        dataResult = processExistencias(dataResult);

        // 6. Cálculos y Estructura de Paginación
        const totalPages = Math.ceil(totalRegistros / limit);
        const currentPage = Math.floor(offset / limit) + 1;
        
        // Devolver la Respuesta con la estructura solicitada
        res.json({
            data: dataResult,
            pagination: {
                currentPage: currentPage,
                totalPages: totalPages,
                totalRecords: totalRegistros,
                limit: limit
            },
        });
        
    } catch (error) {
        console.error('Error al ejecutar la consulta de filtrado de claves alternas:', error);
        res.status(500).json({ 
            error: 'Error interno del servidor al obtener las claves alternas por filtro.', 
            detalles: error.message 
        });
    }
}); */

/* app.get('/clavesalternas/filter', async (req, res) => {
    
    // 1. Configuración inicial
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const { SUCURSAL } = req.query; 
    const cvePrecio = SUCURSAL ? parseInt(SUCURSAL) : 1; 
    const NUMERIC_TOLERANCE = 0.00001; 

    // 2. Mapeo de filtros (Aquí agregamos COLOCACION y LINEA)
    const filterMap = {
        FAMILIA: 'T4.CAMPLIB22',
        DIAM_INT: 'T4.CAMPLIB1',
        DIAM_EXT: 'T4.CAMPLIB2',
        ALTURA: 'T4.CAMPLIB3',
        SECCION: 'T4.CAMPLIB7',
        PERFIL: 'T4.CAMPLIB13', 
        SIST_MED: 'T4.CAMPLIB17',
        COLOCACION: 'T4.CAMPLIB28', // <-- Nuevo filtro
        LINEA: 'T1.LIN_PROD'        // <-- Nuevo filtro
    };

    // Campos que requieren tratamiento numérico especial
    const numericDimensionalFields = ['T4.CAMPLIB1', 'T4.CAMPLIB2', 'T4.CAMPLIB3', 'T4.CAMPLIB7'];
    
    let whereClauses = [];
    let params = [];
    
    // Filtro base: solo productos principales
    whereClauses.push("T2.TIPO = 'P'");

    // Construcción dinámica de la cláusula WHERE
    for (const alias in filterMap) {
        const column = filterMap[alias]; 
        let queryValue = req.query[alias.toLowerCase()]; 

        if (queryValue) {
            queryValue = queryValue.replace(/\+/g, ' ').trim(); 
            if (queryValue === '') continue; 

            if (numericDimensionalFields.includes(column)) {
                // Lógica para números (tolerancia decimal)
                const cleanNumericValue = parseFloat(queryValue.replace(',', '.'));
                if (isNaN(cleanNumericValue)) continue; 
                const dbColumnExpression = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${column}), ''), '0'), ',', '.') AS NUMERIC(15, 5))`;
                whereClauses.push(`ABS(${dbColumnExpression} - CAST(? AS NUMERIC(15, 5))) <= ${NUMERIC_TOLERANCE}`);
                params.push(cleanNumericValue); 
            } else {
                // Lógica para texto (LIKE) - Aplica a FAMILIA, COLOCACION, LINEA, etc.
                const upperQueryValue = queryValue.toUpperCase();
                const likeTerm = `%${upperQueryValue}%`;
                const dbColumnExpression = `UPPER(TRIM(${column}))`;
                whereClauses.push(`${dbColumnExpression} LIKE CAST(? AS VARCHAR(255))`);
                params.push(likeTerm);
            }
        }
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // 3. Consulta de CONTEO
    const countSql = `
        SELECT COUNT(DISTINCT T1.CVE_ART) AS TOTAL_REGISTROS
        FROM INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        ${whereString};
    `;
    
    // 4. Consulta de DATOS
    const dataSql = `
        SELECT FIRST ${limit} SKIP ${offset}
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO, T1.LIN_PROD,
            T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, T4.CAMPLIB13 AS PERFIL, 
            T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA, T4.CAMPLIB28 AS COLOCACION,
            COALESCE(MAX(T5.PRECIO), 0.00) AS PRECIO, 
            MAX(CASE WHEN TRIM(T2.CVE_CLPV) = '3' THEN T2.CVE_ALTER ELSE NULL END) AS PROV1, 
            MAX(CASE WHEN TRIM(T2.CVE_CLPV) = '35' THEN T2.CVE_ALTER ELSE NULL END) AS PROV2,
            MAX(CASE WHEN T6.CVE_ALM = '1' THEN T6.EXIST ELSE NULL END) AS ALM_1_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '3' THEN T6.EXIST ELSE NULL END) AS ALM_3_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '5' THEN T6.EXIST ELSE NULL END) AS ALM_5_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '6' THEN T6.EXIST ELSE NULL END) AS ALM_6_EXIST,
            MAX(CASE WHEN T6.CVE_ALM = '7' THEN T6.EXIST ELSE NULL END) AS ALM_7_EXIST
        FROM INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        LEFT JOIN PRECIO_X_PROD02 T5 ON T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = ? 
        LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
        ${whereString}
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
        ORDER BY T1.CVE_ART;
    `;

    try {
        // Ejecutar Conteo
        const countResult = await db.query(countSql, params);
        const totalRegistros = countResult[0].TOTAL_REGISTROS || 0;

        if (totalRegistros === 0 && Object.keys(req.query).some(key => key !== 'limit' && key !== 'offset')) {
            return res.status(404).json({ message: 'No se encontraron resultados.' });
        }

        // Ejecutar Datos
        let dataResult = await db.query(dataSql, [cvePrecio, ...params]); 

        // 5. Consultar Empresa 3 (Fresnillo2 - Almacén 3)
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
                resEmp3.forEach(row => {
                    existenciaEmp3Map[row.ART] = row.EXIST;
                });

                dataResult = dataResult.map(item => ({
                    ...item,
                    ALM_10_EXIST: existenciaEmp3Map[item.CVE_ART.trim()] || 0
                }));
            } catch (err3) {
                console.error("Error en DB3:", err3);
                dataResult = dataResult.map(item => ({ ...item, ALM_10_EXIST: 0 }));
            }
        }

        // 6. Post-procesamiento
        dataResult = processExistencias(dataResult);

        const totalPages = Math.ceil(totalRegistros / limit);
        const currentPage = Math.floor(offset / limit) + 1;
        
        res.json({
            data: dataResult,
            pagination: {
                currentPage,
                totalPages,
                totalRecords: totalRegistros,
                limit
            },
        });
        
    } catch (error) {
        console.error('Error en filter:', error);
        res.status(500).json({ error: 'Error interno del servidor.', detalles: error.message });
    }
}); */

app.get('/clavesalternas/filter', async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const { SUCURSAL } = req.query; 
    const cvePrecio = SUCURSAL ? SUCURSAL.toString() : '1'; 

    const filterMap = {
        FAMILIA: 'T4.CAMPLIB22',
        DIAM_INT: 'T4.CAMPLIB1',
        DIAM_EXT: 'T4.CAMPLIB2',
        ALTURA: 'T4.CAMPLIB3',
        SECCION: 'T4.CAMPLIB7',
        PERFIL: 'T4.CAMPLIB13', 
        SIST_MED: 'T4.CAMPLIB17',
        COLOCACION: 'T4.CAMPLIB28',
        LINEA: 'T1.LIN_PROD'
    };

    const numericDimensionalFields = ['T4.CAMPLIB1', 'T4.CAMPLIB2', 'T4.CAMPLIB3', 'T4.CAMPLIB7'];
    
    // Mantenemos T2.TIPO = 'P' porque entiendo que solo quieres productos con clave principal
    let whereClauses = ["T2.TIPO = 'P'"]; 
    let params = [];

    for (const alias in filterMap) {
        const column = filterMap[alias]; 
        let queryValue = req.query[alias.toLowerCase()]; 

        if (queryValue) {
            queryValue = queryValue.trim();
            if (queryValue === '') continue; 

            if (numericDimensionalFields.includes(column)) {
                const cleanNumericValue = parseFloat(queryValue.replace(',', '.'));
                if (isNaN(cleanNumericValue)) continue; 
                
                // COALESCE asegura que si el campo está vacío, se trate como 0 y no se descarte la fila
                const dbColumnExpression = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${column}), ''), '0'), ',', '.') AS NUMERIC(15, 5))`;
                whereClauses.push(`ABS(${dbColumnExpression} - CAST(? AS NUMERIC(15, 5))) <= 0.00001`);
                params.push(cleanNumericValue); 
            } else {
                // COALESCE asegura que si el campo texto es NULL, se trate como '' (cadena vacía)
                const dbColumnExpression = `UPPER(TRIM(COALESCE(${column}, '')))`;
                whereClauses.push(`${dbColumnExpression} LIKE ?`);
                params.push(`%${queryValue.toUpperCase()}%`);
            }
        }
    }

    const whereString = `WHERE ${whereClauses.join(' AND ')}`;

    // CONSULTA REESTRUCTURADA:
    // 1. Usamos LEFT JOIN para TODO excepto para CVES_ALTER02 (T2) que define el TIPO='P'
    // 2. Colocamos el filtro de CVE_PRECIO dentro del ON del LEFT JOIN, no en el WHERE
    const dataSql = `
        SELECT FIRST ${limit} SKIP ${offset}
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
        INNER JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        -- El filtro de precio DEBE ir aquí en el JOIN para que si no hay precio, la fila de T1 no se pierda
        LEFT JOIN PRECIO_X_PROD02 T5 ON (T1.CVE_ART = T5.CVE_ART AND TRIM(T5.CVE_PRECIO) = CAST(? AS VARCHAR(10)))
        LEFT JOIN MULT02 T6 ON T1.CVE_ART = T6.CVE_ART
        ${whereString}
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
        ORDER BY T1.CVE_ART;
    `;

    try {
        const countSql = `SELECT COUNT(DISTINCT T1.CVE_ART) AS TOTAL 
                          FROM INVE02 T1 
                          INNER JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART 
                          LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD 
                          ${whereString}`;
        
        const countRes = await db.query(countSql, params);
        const totalRecords = countRes[0].TOTAL || 0;

        let dataResult = await db.query(dataSql, [cvePrecio, ...params]); 

        // Enriquecer con Fresnillo2 (DB3)
        if (dataResult.length > 0) {
            const ids = dataResult.map(item => item.CVE_ART.trim());
            const sql3 = `SELECT TRIM(CVE_ART) AS ART, EXIST FROM MULT03 WHERE CVE_ALM = 3 AND CVE_ART IN (${ids.map(() => '?').join(',')})`;
            const res3 = await db3.query(sql3, ids);
            const map3 = {};
            res3.forEach(r => map3[r.ART] = r.EXIST);
            dataResult = dataResult.map(item => ({ 
                ...item, 
                ALM_10_EXIST: map3[item.CVE_ART.trim()] || 0 
            }));
        }

        dataResult = processExistencias(dataResult);
        res.json({ data: dataResult, pagination: { totalRecords, limit } });

    } catch (error) {
        console.error("Error en filter:", error);
        res.status(500).json({ error: error.message });
    }
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});