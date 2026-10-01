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

const obtenerVentasClientes = async (almacen, cliente) => {
    // Si queremos buscar en db3 cuando almacen es 3, podríamos hacerlo.
    // Por el requerimiento base de CLIE02 y FACTF02, lo haremos sobre db (02).
    const isAlmacen3 = almacen && String(almacen) === '3';
    const database = isAlmacen3 ? db3 : db;
    const tablaClie = isAlmacen3 ? 'CLIE03' : 'CLIE02';
    const tablaFact = isAlmacen3 ? 'FACTF03' : 'FACTF02';

    const params = [];

    // Base del SQL
    let sql = `
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
            F.NUM_ALMA,
            MAX(F.FECHA_DOC) AS FECHA_ULTIMA_COMPRA
        FROM ${tablaClie} C
    `;

    // LEFT JOIN para permitir traer clientes aunque no tengan compras
    if (almacen) {
        sql += ` LEFT JOIN ${tablaFact} F ON C.CLAVE = F.CVE_CLPV AND F.NUM_ALMA = ? AND F.STATUS <> 'C'`;
        params.push(almacen);
    } else {
        sql += ` LEFT JOIN ${tablaFact} F ON C.CLAVE = F.CVE_CLPV AND F.STATUS <> 'C'`;
    }

    // Filtros de tabla clientes
    sql += ` WHERE C.STATUS = 'A'`;

    if (cliente) {
        // Ahora busca estrictamente coincidencias en la CLAVE del cliente
        sql += ` AND UPPER(TRIM(C.CLAVE)) CONTAINING UPPER(?)`;
        params.push(cliente);
    }

    // Agrupación de todos los campos de cliente
    sql += `
        GROUP BY 
            C.CLAVE, C.NOMBRE, C.RFC, C.CALLE, C.NUMEXT, C.NUMINT,
            C.COLONIA, C.CODIGO, C.LOCALIDAD, C.MUNICIPIO, C.ESTADO,
            C.TELEFONO, C.PAG_WEB, C.EMAILPRED, C.SALDO, C.LISTA_PREC, C.FCH_ULTCOM, F.NUM_ALMA
    `;

    // Ordenamiento: nulls al principio (clientes que nunca compran), luego las fechas más antiguas
    sql += ` ORDER BY MAX(F.FECHA_DOC) ASC NULLS FIRST`;

    const resultados = await database.query(sql, params);
    return resultados;
};

module.exports = {
    buscarClientePorRFC,
    obtenerVentasClientes
};