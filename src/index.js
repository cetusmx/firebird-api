// src/index.js
const express = require('express');
const morgan = require('morgan');
const db = require('./db');
const cors = require('cors');
require('dotenv').config();

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

// src/index.js

// ... (código anterior)

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

// index.js

// ... (código anterior)

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

/* // Endpoint para búsqueda de Claves Alternas, utilizado en inputs de autocompletado
app.get('/clavesalternas/search', async (req, res) => {
  // Obtener el término de búsqueda de los query parameters (ej: /search?query=XYZ)
  //const searchTerm = req.query.query ? req.query.query.toUpperCase() : '';
  const searchTerm = req.query.query ? req.query.query.toUpperCase() : '';
  console.log(searchTerm);

  // Usamos el símbolo '%' para la búsqueda LIKE en SQL
  const likeTerm = `%${searchTerm}%`;

  // Consulta SQL (similar a /clavesalternas pero con filtro WHERE)
  const sql = `
    SELECT FIRST 50
      T1.CVE_ART,         -- Clave de Producto (INVE02)
      T1.DESCR,           -- Descripción (INVE02)
      T1.UNI_MED,         -- Unidad de Medida (INVE02)
      T1.FCH_ULTCOM,      -- Fecha Última Compra (INVE02)
      T1.ULT_COSTO,       -- Último Costo (INVE02)
      T2.CVE_ALTER,       -- Clave Alterna (CVES_ALTER02)
      T2.CVE_CLPV,        -- Clave de Proveedor (CVES_ALTER02)
      T3.NOMBRE           -- Nombre del Proveedor (PROV02)
    FROM
      INVE02 T1
    LEFT JOIN
      CVES_ALTER02 T2
      ON T1.CVE_ART = T2.CVE_ART
    LEFT JOIN
      PROV02 T3
      ON T2.CVE_CLPV = T3.CLAVE
    WHERE
      T2.TIPO = 'P' -- Filtro requerido: Solo claves alternas de TIPO "P"
      AND (
        T1.CVE_ART LIKE CAST(? AS VARCHAR(255)) OR       -- <--- ¡CAST APLICADO AQUÍ!
        T1.DESCR LIKE CAST(? AS VARCHAR(255)) OR         -- <--- ¡CAST APLICADO AQUÍ!
        T2.CVE_ALTER LIKE CAST(? AS VARCHAR(255)) OR     -- <--- ¡CAST APLICADO AQUÍ!
        T3.NOMBRE LIKE CAST(? AS VARCHAR(255))
      )
    ORDER BY
      T1.CVE_ART, T2.CVE_ALTER;
  `;

  // El array de parámetros debe contener 'likeTerm' repetido cuatro veces para la búsqueda OR
  const params = [likeTerm, likeTerm, likeTerm, likeTerm];

  try {
    const resultados = await db.query(sql, params);

    if (resultados.length === 0 && searchTerm.length > 0) {
        return res.status(404).json({ message: `No se encontraron coincidencias para "${searchTerm}".` });
    }
    
    res.json(resultados);
  } catch (error) {
    console.error('Error al ejecutar la consulta de búsqueda de claves alternas:', error);
    res.status(500).json({ 
        error: 'Error interno del servidor al obtener las claves alternas para la búsqueda.', 
        detalles: error.message 
    });
  }
}); */

// index.js

// ... (código anterior)

// Endpoint para búsqueda de Claves Alternas, utilizado en inputs de autocompletado
/* app.get('/clavesalternas/search', async (req, res) => {
  const searchTerm = req.query.query ? req.query.query.toUpperCase() : '';
  console.log(searchTerm);

  const likeTerm = `%${searchTerm}%`;

  // Consulta SQL (MODIFICADA: Agregando INVE_CLIB02 con CAST para el LIKE)
  const sql = `
    SELECT FIRST 50
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
      INVE02 T1
    LEFT JOIN
      CVES_ALTER02 T2
      ON T1.CVE_ART = T2.CVE_ART
    LEFT JOIN
      PROV02 T3
      ON T2.CVE_CLPV = T3.CLAVE
    LEFT JOIN
      INVE_CLIB02 T4 -- <--- ¡NUEVO JOIN para campos libres!
      ON T1.CVE_ART = T4.CVE_PROD
    WHERE
      T2.TIPO = 'P' -- Filtro requerido: Solo claves alternas de TIPO "P"
      AND (
        T1.CVE_ART LIKE CAST(? AS VARCHAR(255)) OR
        T1.DESCR LIKE CAST(? AS VARCHAR(255)) OR
        T2.CVE_ALTER LIKE CAST(? AS VARCHAR(255)) OR
        T3.NOMBRE LIKE CAST(? AS VARCHAR(255))
      )
    ORDER BY
      T1.CVE_ART, T2.CVE_ALTER;
  `;

  // El array de parámetros sigue siendo el mismo.
  const params = [likeTerm, likeTerm, likeTerm, likeTerm];

  try {
    const resultados = await db.query(sql, params);

    if (resultados.length === 0 && searchTerm.length > 0) {
        return res.status(404).json({ message: `No se encontraron coincidencias para "${searchTerm}".` });
    }
    
    res.json(resultados);
  } catch (error) {
    console.error('Error al ejecutar la consulta de búsqueda de claves alternas:', error);
    res.status(500).json({ 
        error: 'Error interno del servidor al obtener las claves alternas para la búsqueda.', 
        detalles: error.message 
    });
  }
}); */

// index.js

// ... (código anterior)

// Endpoint para buscar productos por diversos campos (CVE_ART, DESCR, CVE_ALTER, NOMBRE)
// y consolidar las claves alternas de proveedores '3' y '35' en columnas PROV1 y PROV2.
app.get('/clavesalternas/search', async (req, res) => {
  const { query } = req.query;
  const searchTerm = query ? query.toUpperCase().trim() : '';
  const likeTerm = `%${searchTerm}%`;

  const sql = `
    SELECT FIRST 50
      T1.CVE_ART, 
      T1.DESCR, 
      T1.UNI_MED, 
      T1.FCH_ULTCOM, 
      T1.ULT_COSTO,
      
      -- 1. PIVOT: Clave alterna del Proveedor '3' (PROV1)
      MAX(CASE 
        WHEN TRIM(T2.CVE_CLPV) = '3' 
        THEN T2.CVE_ALTER 
        ELSE NULL 
      END) AS PROV1, 
      
      -- 2. PIVOT: Clave alterna del Proveedor '35' (PROV2)
      MAX(CASE 
        WHEN TRIM(T2.CVE_CLPV) = '35' 
        THEN T2.CVE_ALTER 
        ELSE NULL 
      END) AS PROV2
      
    FROM
      INVE02 T1
    LEFT JOIN
      CVES_ALTER02 T2
      ON T1.CVE_ART = T2.CVE_ART
    LEFT JOIN
      PROV02 T3
      ON T2.CVE_CLPV = T3.CLAVE
    WHERE
      T2.TIPO = 'P' -- Filtro requerido: Solo claves alternas de TIPO "P"
      AND (\r\n
        T1.CVE_ART LIKE CAST(? AS VARCHAR(255)) OR       
        T1.DESCR LIKE CAST(? AS VARCHAR(255)) OR         
        T2.CVE_ALTER LIKE CAST(? AS VARCHAR(255)) OR     
        T3.NOMBRE LIKE CAST(? AS VARCHAR(255))
      )
    GROUP BY
      T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO
    ORDER BY
      T1.CVE_ART;
  `;

  // El array de parámetros debe contener 'likeTerm' repetido cuatro veces para la búsqueda OR
  const params = [likeTerm, likeTerm, likeTerm, likeTerm];

  try {
    const resultados = await db.query(sql, params);

    // Si no hay resultados y el usuario buscó algo, devuelve 404
    if (resultados.length === 0 && searchTerm.length > 0) {
        return res.status(404).json({ message: `No se encontraron coincidencias para "${searchTerm}".` });
    }
    
    // Si no hay resultados pero no se buscó nada (ej: consulta inicial sin término), devuelve 200 con array vacío
    if (resultados.length === 0) {
        return res.status(200).json([]);
    }

    res.json(resultados);
  } catch (error) {
    console.error('Error al ejecutar la consulta de búsqueda de claves alternas:', error);
    res.status(500).json({ error: 'Error interno del servidor al obtener las claves alternas.', detalles: error.message });
  }
});

// Nuevo Endpoint para obtener las familias únicas de INVE_CLIB02
app.get('/familias', async (req, res) => {
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
});

// Nuevo Endpoint para búsqueda y filtrado avanzado con paginación
// Acepta: ?familia=X&diam_int=Y&limit=50&offset=0
/* app.get('/clavesalternas/filter', async (req, res) => {
    // 1. Configuración de Paginación
    const limit = parseInt(req.query.limit) || 100; // Límite por defecto de 100
    const offset = parseInt(req.query.offset) || 0; // Desplazamiento por defecto 0

    // 2. Definición de Parámetros de Filtrado
    // Mapeamos los query params a los nombres reales de las columnas en INVE_CLIB02
    const filterMap = {
        FAMILIA: 'T4.CAMPLIB22',
        DIAM_INT: 'T4.CAMPLIB1',
        DIAM_EXT: 'T4.CAMPLIB2',
        ALTURA: 'T4.CAMPLIB3',
        SECCION: 'T4.CAMPLIB7',
        SIST_MED: 'T4.CAMPLIB17',
    };

    let whereClauses = [];
    let params = [];
    
    // 3. Construcción Dinámica de la Cláusula WHERE
    // Siempre incluimos el filtro TIPO = 'P' y construimos los demás dinámicamente.
    whereClauses.push("T2.TIPO = 'P'");

    for (const alias in filterMap) {
        // Normalizamos el valor del query (mayúsculas, recortar espacios)
        let queryValue = req.query[alias.toLowerCase()]; 

        if (queryValue) {
          // 1. Reemplazar cualquier '+' por un espacio.
            // 2. Normalizar a mayúsculas y eliminar espacios extra.
            queryValue = queryValue.replace(/\+/g, ' ').toUpperCase().trim();

            if (queryValue === '') continue; // Ignorar si queda vacío tras limpiar

            const column = filterMap[alias];
            const likeTerm = `${queryValue}%`;
            
            // Usamos LIKE, manteniendo UPPER(TRIM()) y CAST para la máxima fiabilidad
            whereClauses.push(`UPPER(TRIM(${column})) LIKE CAST(? AS VARCHAR(255))`);

            params.push(likeTerm);
        }
    }

    // 4. Creación de la Consulta SQL Final
    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const sql = `
        SELECT FIRST ${limit} SKIP ${offset} -- <--- Implementación de Paginación Firebird
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO,
            T2.CVE_ALTER, T2.CVE_CLPV, T3.NOMBRE,
            -- Campos de INVE_CLIB02 T4
            T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA
        FROM
            INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN PROV02 T3 ON T2.CVE_CLPV = T3.CLAVE
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        ${whereString}
        ORDER BY
            T1.CVE_ART, T2.CVE_ALTER;
    `;

    try {
        const resultados = await db.query(sql, params);

        // Si no se recibe ningún parámetro de filtro (solo paginación), se devuelven todos los resultados paginados.
        // Si no se encuentran resultados con filtros, se devuelve un 404.
        if (resultados.length === 0 && Object.keys(req.query).some(key => key !== 'limit' && key !== 'offset')) {
             return res.status(404).json({ message: 'No se encontraron resultados que coincidan con los criterios de filtro.' });
        }

        res.json(resultados);
    } catch (error) {
        console.error('Error al ejecutar la consulta de filtrado de claves alternas:', error);
        res.status(500).json({ 
            error: 'Error interno del servidor al obtener las claves alternas por filtro.', 
            detalles: error.message 
        });
    }
}); */

// Endpoint para búsqueda y filtrado avanzado con paginación
// Acepta: ?familia=X&diam_int=Y&limit=10&offset=0
/* app.get('/clavesalternas/filter', async (req, res) => {
    
    // 1. Configuración de Paginación
    // Convertimos los query params a números, con valores por defecto
    const limit = parseInt(req.query.limit) || 100; // Límite por defecto de 100
    const offset = parseInt(req.query.offset) || 0; // Desplazamiento por defecto 0

    // 2. Definición de Parámetros de Filtrado
    // Mapeamos los alias de los query params a los nombres reales de las columnas en INVE_CLIB02
    const filterMap = {
        FAMILIA: 'T4.CAMPLIB22',
        DIAM_INT: 'T4.CAMPLIB1',
        DIAM_EXT: 'T4.CAMPLIB2',
        ALTURA: 'T4.CAMPLIB3',
        SECCION: 'T4.CAMPLIB7',
        SIST_MED: 'T4.CAMPLIB17',
    };

    let whereClauses = [];
    let params = [];
    
    // El filtro TIPO = 'P' es obligatorio
    whereClauses.push("T2.TIPO = 'P'");

    // 3. Construcción Dinámica de la Cláusula WHERE
    for (const alias in filterMap) {
        let queryValue = req.query[alias.toLowerCase()]; 

        if (queryValue) {
            // Limpieza y normalización de la cadena: reemplazamos '+' por espacio y convertimos a mayúsculas
            queryValue = queryValue.replace(/\+/g, ' ').toUpperCase().trim(); 
            
            if (queryValue === '') continue; // Saltar si queda vacío

            const column = filterMap[alias];
            const likeTerm = `${queryValue}%`;
            
            // Lógica robusta: UPPER(TRIM(columna)) LIKE '%?%' con CAST para evitar errores de Firebird
            whereClauses.push(`UPPER(TRIM(${column})) LIKE CAST(? AS VARCHAR(255))`);
            params.push(likeTerm);
        }
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // 4. Consulta de CONTEO (Total de Registros)
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
    
    // 5. Consulta de DATOS (Paginada)
    const dataSql = `
        SELECT FIRST ${limit} SKIP ${offset}
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO,
            T2.CVE_ALTER, T2.CVE_CLPV, T3.NOMBRE,
            T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA
        FROM
            INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN PROV02 T3 ON T2.CVE_CLPV = T3.CLAVE
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        ${whereString}
        ORDER BY
            T1.CVE_ART, T2.CVE_ALTER;
    `;

    try {
        // Ejecutar CONTEO
        const countResult = await db.query(countSql, params);
        const totalRegistros = countResult[0].TOTAL_REGISTROS || 0;

        // Manejo de 404 si hay filtros y el conteo es cero
        if (totalRegistros === 0 && Object.keys(req.query).some(key => key !== 'limit' && key !== 'offset')) {
            return res.status(404).json({ message: 'No se encontraron resultados que coincidan con los criterios de filtro.' });
        }

        // Ejecutar DATOS
        const dataResult = await db.query(dataSql, params);

        // 6. Cálculos y Estructura de Paginación
        const totalPages = Math.ceil(totalRegistros / limit);
        const currentPage = Math.floor(offset / limit) + 1;
        
        // Devolver la Respuesta con la estructura solicitada
        res.json({
            data: dataResult,
            pagination: {
                currentPage: currentPage,
                totalPages: totalPages,
                totalRecords: totalRegistros, // Incluimos totalRecords para referencia
                limit: limit // Incluimos el límite para referencia
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

// index.js

// ... (otros endpoints)

// Endpoint para búsqueda y filtrado avanzado con paginación
/* app.get('/clavesalternas/filter', async (req, res) => {
    
    // 1. Configuración de Paginación
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    // 2. Definición de Parámetros de Filtrado
    const filterMap = {
        FAMILIA: 'T4.CAMPLIB22',
        DIAM_INT: 'T4.CAMPLIB1',
        DIAM_EXT: 'T4.CAMPLIB2',
        ALTURA: 'T4.CAMPLIB3',
        SECCION: 'T4.CAMPLIB7',
        SIST_MED: 'T4.CAMPLIB17',
    };

    // Campos que deben ser tratados como NÚMEROS (para CAST a NUMERIC)
    const numericDimensionalFields = ['T4.CAMPLIB1', 'T4.CAMPLIB2', 'T4.CAMPLIB3', 'T4.CAMPLIB7'];
    
    let whereClauses = [];
    let params = [];
    
    // El filtro TIPO = 'P' es obligatorio
    whereClauses.push("T2.TIPO = 'P'");

    // 3. Construcción Dinámica de la Cláusula WHERE con limpieza de datos
    for (const alias in filterMap) {
        let queryValue = req.query[alias.toLowerCase()]; 

        if (queryValue) {
            // Limpieza inicial: reemplazamos '+' por espacio y eliminamos espacios extra
            queryValue = queryValue.replace(/\+/g, ' ').trim(); 
            
            if (queryValue === '') continue; 

            const column = filterMap[alias];
            
            // --- Lógica para Campos NUMÉRICOS (Dimensiones) ---
            if (numericDimensionalFields.includes(column)) {
                
                // 1. Convertimos la cadena de búsqueda a un número (maneja '2.5' o '2,5')
                // Usamos .replace(',', '.') para que parseFloat() funcione correctamente
                const cleanNumericValue = parseFloat(queryValue.replace(',', '.'));
                
                if (isNaN(cleanNumericValue)) continue; 

                // Expresión en DB: Limpia espacios, reemplaza coma por punto, y CONVIERTE A NUMÉRICO
                //const dbColumnExpression = `CAST(REPLACE(TRIM(${column}), ',', '.') AS NUMERIC(15, 5))`;
                const dbColumnExpression = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${column}), ''), '0'), ',', '.') AS NUMERIC(15, 5))`;
                
                // Usamos IGUALDAD (=) para la coincidencia numérica exacta
                whereClauses.push(`${dbColumnExpression} = CAST(? AS NUMERIC(15, 5))`);
                params.push(cleanNumericValue); 

            } else {
                // --- Lógica para Campos de TEXTO (FAMILIA, SIST_MED) ---
                
                // 1. Convertimos el valor de búsqueda a mayúsculas
                const upperQueryValue = queryValue.toUpperCase();
                const likeTerm = `%${upperQueryValue}%`;

                // Expresión en DB: UPPER(TRIM())
                const dbColumnExpression = `UPPER(TRIM(${column}))`;

                // Mantenemos LIKE para los campos de texto
                whereClauses.push(`${dbColumnExpression} LIKE CAST(? AS VARCHAR(255))`);
                params.push(likeTerm);
            }
        }
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // 4. Consulta de CONTEO y DATOS (se mantienen igual, usando whereString y params)
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
    
    const dataSql = `
        SELECT FIRST ${limit} SKIP ${offset}
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO,
            T2.CVE_ALTER, T2.CVE_CLPV, T3.NOMBRE,
            T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA
        FROM
            INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN PROV02 T3 ON T2.CVE_CLPV = T3.CLAVE
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        ${whereString}
        ORDER BY
            T1.CVE_ART, T2.CVE_ALTER;
    `;

    try {
        // Ejecutar CONTEO
        const countResult = await db.query(countSql, params);
        const totalRegistros = countResult[0].TOTAL_REGISTROS || 0;

        // Manejo de 404 si hay filtros y el conteo es cero
        if (totalRegistros === 0 && Object.keys(req.query).some(key => key !== 'limit' && key !== 'offset')) {
            return res.status(404).json({ message: 'No se encontraron resultados que coincidan con los criterios de filtro.' });
        }

        // Ejecutar DATOS
        const dataResult = await db.query(dataSql, params);

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

// index.js

// ... (otros endpoints)

// Endpoint para búsqueda y filtrado avanzado con paginación
app.get('/clavesalternas/filter', async (req, res) => {
    
    // 1. Configuración de Paginación
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    // 2. Definición de Parámetros de Filtrado
    const filterMap = {
        FAMILIA: 'T4.CAMPLIB22',
        DIAM_INT: 'T4.CAMPLIB1',
        DIAM_EXT: 'T4.CAMPLIB2',
        ALTURA: 'T4.CAMPLIB3',
        SECCION: 'T4.CAMPLIB7',
        SIST_MED: 'T4.CAMPLIB17',
    };

    // Campos que deben ser tratados como NÚMEROS (para CAST a NUMERIC)
    const numericDimensionalFields = ['T4.CAMPLIB1', 'T4.CAMPLIB2', 'T4.CAMPLIB3', 'T4.CAMPLIB7'];
    
    let whereClauses = [];
    let params = [];
    
    // El filtro TIPO = 'P' es obligatorio
    whereClauses.push("T2.TIPO = 'P'");

    // 3. Construcción Dinámica de la Cláusula WHERE con limpieza de datos
    for (const alias in filterMap) {
        let queryValue = req.query[alias.toLowerCase()]; 

        if (queryValue) {
            queryValue = queryValue.replace(/\+/g, ' ').trim(); 
            
            if (queryValue === '') continue; 

            const column = filterMap[alias];
            
            // --- Lógica para Campos NUMÉRICOS (Dimensiones) ---
            if (numericDimensionalFields.includes(column)) {
                
                const cleanNumericValue = parseFloat(queryValue.replace(',', '.'));
                
                if (isNaN(cleanNumericValue)) continue; 

                // COALESCE/NULLIF/REPLACE para manejar nulos, vacíos y comas antes del CAST a NUMERIC
                const dbColumnExpression = `CAST(REPLACE(COALESCE(NULLIF(TRIM(${column}), ''), '0'), ',', '.') AS NUMERIC(15, 5))`;
                
                // Usamos IGUALDAD (=) para la coincidencia numérica exacta
                whereClauses.push(`${dbColumnExpression} = CAST(? AS NUMERIC(15, 5))`);
                params.push(cleanNumericValue); 

            } else {
                // --- Lógica para Campos de TEXTO (FAMILIA, SIST_MED) ---
                
                const upperQueryValue = queryValue.toUpperCase();
                const likeTerm = `%${upperQueryValue}%`;

                const dbColumnExpression = `UPPER(TRIM(${column}))`;

                // Mantenemos LIKE para los campos de texto
                whereClauses.push(`${dbColumnExpression} LIKE CAST(? AS VARCHAR(255))`);
                params.push(likeTerm);
            }
        }
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // 4. Consulta de CONTEO (Se mantiene igual y correcta)
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
    
    // 5. Consulta de DATOS (Paginada y Consolidada - ¡CORRECCIÓN APLICADA!)
    const dataSql = `
        SELECT FIRST ${limit} SKIP ${offset}
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO,
            T4.CAMPLIB1 AS DIAM_INT, T4.CAMPLIB2 AS DIAM_EXT, T4.CAMPLIB3 AS ALTURA,
            T4.CAMPLIB7 AS SECCION, T4.CAMPLIB15 AS CLA_SYR, T4.CAMPLIB16 AS CLA_LC,
            T4.CAMPLIB17 AS SIST_MED, T4.CAMPLIB19 AS DESC_ECOMM, T4.CAMPLIB21 AS GENERO,
            T4.CAMPLIB22 AS FAMILIA,
            
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
            END) AS PROV2
            
        FROM
            INVE02 T1
        LEFT JOIN CVES_ALTER02 T2 ON T1.CVE_ART = T2.CVE_ART
        LEFT JOIN PROV02 T3 ON T2.CVE_CLPV = T3.CLAVE
        LEFT JOIN INVE_CLIB02 T4 ON T1.CVE_ART = T4.CVE_PROD
        ${whereString}
        
        -- Agrupamos por todos los campos de T1 y T4 para obtener una fila única por producto
        GROUP BY
            T1.CVE_ART, T1.DESCR, T1.UNI_MED, T1.FCH_ULTCOM, T1.ULT_COSTO,
            T4.CAMPLIB1, T4.CAMPLIB2, T4.CAMPLIB3, T4.CAMPLIB7, T4.CAMPLIB15, 
            T4.CAMPLIB16, T4.CAMPLIB17, T4.CAMPLIB19, T4.CAMPLIB21, T4.CAMPLIB22
            
        ORDER BY
            T1.CVE_ART;
    `;

    try {
        // Ejecutar CONTEO
        const countResult = await db.query(countSql, params);
        const totalRegistros = countResult[0].TOTAL_REGISTROS || 0;

        // Manejo de 404 si hay filtros y el conteo es cero
        if (totalRegistros === 0 && Object.keys(req.query).some(key => key !== 'limit' && key !== 'offset')) {
            return res.status(404).json({ message: 'No se encontraron resultados que coincidan con los criterios de filtro.' });
        }

        // Ejecutar DATOS
        const dataResult = await db.query(dataSql, params);

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
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});