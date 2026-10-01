const db = require('../db');   // Empresa 02 (Principal)
const db3 = require('../db3'); // Empresa 03 (Fresnillo)

/**
 * Obtiene los datos fiscales y de contacto de un cliente por su RFC.
 * Si no se especifica sucursal, busca en ambas empresas y elimina duplicados usando SOLO el RFC.
 * 
 * @param {string} rfc RFC del cliente a buscar.
 * @param {string} sucursal Opcional: '3' (Fresnillo), '1'/'2' (Principal), o vacío (Global).
 */
const buscarClientePorRFC = async (rfc, sucursal) => {
    const rfcLimpio = String(rfc).trim().toUpperCase();

    // AQUÍ ESTABA EL ERROR: Faltaba la línea WHERE TRIM(UPPER(RFC)) = ?
    const sql = `
        SELECT 
            TRIM(CLAVE) as "CLAVE",
            TRIM(NOMBRE) as "NOMBRE",
            TRIM(RFC) as "RFC",
            TRIM(CALLE) as "CALLE",
            TRIM(NUMEXT) as "NUMEXT",
            TRIM(NUMINT) as "NUMINT",
            TRIM(COLONIA) as "COLONIA",
            TRIM(LOCALIDAD) as "LOCALIDAD",
            TRIM(MUNICIPIO) as "MUNICIPIO",
            TRIM(ESTADO) as "ESTADO",
            TRIM(CODIGO) as "CODIGO",
            TRIM(PAIS) as "PAIS",
            TRIM(EMAILPRED) as "EMAILPRED",
            TRIM(NOMBRECOMERCIAL) as "NOMBRECOMERCIAL",
            TRIM(TELEFONO) as "TELEFONO",
            TRIM(STATUS) as "STATUS"
        FROM CLIE02
        WHERE TRIM(UPPER(RFC)) = ?
    `;

    // Función auxiliar para inyectar el número de tabla dinámicamente
    const buildSql = (numTabla) => sql.replace('CLIE02', `CLIE${numTabla}`);

    let resultados = [];

    // 1. Ejecución Estratégica según la petición
    if (sucursal === '3') {
        // Búsqueda exclusiva en Fresnillo
        resultados = await db3.query(buildSql('03'), [rfcLimpio]);
    } else if (sucursal === '1' || sucursal === '2') {
        // Búsqueda exclusiva en Principal
        resultados = await db.query(buildSql('02'), [rfcLimpio]);
    } else {
        // Búsqueda Global (Ambas empresas en paralelo)
        const [res2, res3] = await Promise.all([
            db.query(buildSql('02'), [rfcLimpio]),
            db3.query(buildSql('03'), [rfcLimpio])
        ]);

        const combinados = [...res2, ...res3];

        // 2. Lógica de Deduplicación (Usando estrictamente el RFC)
        const clientesUnicos = new Map();

        combinados.forEach(cliente => {
            // Utilizamos únicamente el RFC como identificador universal
            const llaveUnica = cliente.RFC;
            
            if (!clientesUnicos.has(llaveUnica)) {
                clientesUnicos.set(llaveUnica, cliente);
            }
        });

        // Convertimos el Map de vuelta a un arreglo
        resultados = Array.from(clientesUnicos.values());
    }

    return resultados;
};

const obtenerAniosVentas = async (almacen) => {
    const isAlmacen3 = almacen && String(almacen) === '3';
    const database = isAlmacen3 ? db3 : db;
    const tablaFact = isAlmacen3 ? 'FACTF03' : 'FACTF02';
    
    // Obtenemos todos los años únicos presentes en la tabla de facturas
    let sql = `SELECT DISTINCT EXTRACT(YEAR FROM FECHA_DOC) AS ANIO FROM ${tablaFact} WHERE STATUS <> 'C'`;
    const params = [];
    
    if (almacen) {
        sql += ` AND NUM_ALMA = ?`;
        params.push(almacen);
    }
    
    sql += ` ORDER BY 1 DESC`;
    
    try {
        const res = await database.query(sql, params);
        // Retornamos un arreglo plano solo con los números [2024, 2023, ...] y filtramos los nulos
        return res.map(r => r.ANIO).filter(a => a !== null);
    } catch (error) {
        console.error("Error al obtener años de ventas:", error);
        return [];
    }
};

const obtenerVentasClientes = async (almacen, cliente, anio) => {
    // Por el requerimiento base de CLIE02 y FACTF02, lo haremos sobre db (02).
    const isAlmacen3 = almacen && String(almacen) === '3';
    const database = isAlmacen3 ? db3 : db;
    const tablaClie = isAlmacen3 ? 'CLIE03' : 'CLIE02';
    const tablaFact = isAlmacen3 ? 'FACTF03' : 'FACTF02';

    const params = [];
    
    // Subconsulta para filtrar por almacén
    let filtroFacturas = '';
    if (almacen) {
        filtroFacturas = ` AND F.NUM_ALMA = ? `;
        // Pasamos el parámetro 3 veces (NUM_ALMA, FECHA_DOC, CANT_TOT)
        params.push(almacen, almacen, almacen);
    }

    // Consulta interna
    let innerSql = `
        SELECT 
            TRIM(C.CLAVE) AS CLAVE,
            TRIM(C.NOMBRE) AS NOMBRE,
            TRIM(C.RFC) AS RFC,
            TRIM(COALESCE(C.CALLE, '')) || ' ' || TRIM(COALESCE(C.NUMEXT, '')) || ' ' || TRIM(COALESCE(C.NUMINT, '')) AS DIRECCION,
            TRIM(C.COLONIA) AS COLONIA,
            TRIM(C.CODIGO) AS CODIGO,
            TRIM(C.LOCALIDAD) AS LOCALIDAD,
            TRIM(C.MUNICIPIO) AS MUNICIPIO,
            TRIM(C.ESTADO) AS ESTADO,
            TRIM(C.TELEFONO) AS TELEFONO,
            TRIM(C.PAG_WEB) AS PAG_WEB,
            TRIM(C.EMAILPRED) AS EMAILPRED,
            C.SALDO,
            C.LISTA_PREC,
            C.FCH_ULTCOM AS FECHA_ULT_COMPRA_GENERAL,
            (SELECT FIRST 1 F.NUM_ALMA FROM ${tablaFact} F WHERE F.CVE_CLPV = C.CLAVE AND F.STATUS <> 'C' ${filtroFacturas} ORDER BY F.FECHA_DOC DESC) AS NUM_ALMA,
            (SELECT FIRST 1 F.FECHA_DOC FROM ${tablaFact} F WHERE F.CVE_CLPV = C.CLAVE AND F.STATUS <> 'C' ${filtroFacturas} ORDER BY F.FECHA_DOC DESC) AS FECHA_ULTIMA_COMPRA,
            (SELECT FIRST 1 F.CANT_TOT FROM ${tablaFact} F WHERE F.CVE_CLPV = C.CLAVE AND F.STATUS <> 'C' ${filtroFacturas} ORDER BY F.FECHA_DOC DESC) AS CANT_TOT
        FROM ${tablaClie} C
        WHERE C.STATUS = 'A'
    `;

    if (cliente) {
        innerSql += ` AND UPPER(TRIM(C.CLAVE)) CONTAINING UPPER(?)`;
        params.push(cliente);
    }

    // Envolvemos en una consulta principal para poder filtrar directamente por el alias calculado (FECHA_ULTIMA_COMPRA)
    let sql = `SELECT * FROM (${innerSql}) T`;

    if (anio) {
        if (anio === 'null' || anio === 'sin_compras') {
            sql += ` WHERE T.FECHA_ULTIMA_COMPRA IS NULL`;
        } else {
            sql += ` WHERE EXTRACT(YEAR FROM T.FECHA_ULTIMA_COMPRA) = ?`;
            params.push(anio);
        }
    }

    // Ordenamos por la FECHA_ULTIMA_COMPRA (Nulls al principio, luego fechas antiguas)
    sql += ` ORDER BY T.FECHA_ULTIMA_COMPRA ASC NULLS FIRST`;

    const resultados = await database.query(sql, params);
    return resultados;
};

module.exports = {
    buscarClientePorRFC,
    obtenerVentasClientes,
    obtenerAniosVentas
};