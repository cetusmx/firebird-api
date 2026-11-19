const db = require('../db');
const db3 = require('../db3');

const CHUNK_SIZE = 400;

/**
 * Divide un arreglo en bloques de tamaño fijo para respetar los límites de Firebird en cláusulas IN.
 * @param {Array} arr
 * @param {number} size
 * @returns {Array<Array>}
 */
function chunkArray(arr, size = CHUNK_SIZE) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

/**
 * Ejecuta una consulta por lotes sobre una conexión dada (de forma secuencial para no saturar el puerto 3050 de Firebird).
 * @param {object} connection Instancia db o db3
 * @param {Array<string>} items Lista de claves/líneas para la cláusula IN
 * @param {Function} sqlBuilder Función (placeholders) => { sql, extraParamsBefore, extraParamsAfter }
 * @returns {Promise<Array>}
 */
async function queryEnLotes(connection, items, sqlBuilder) {
    if (!items || items.length === 0) return [];
    const results = [];
    const chunks = chunkArray(items, CHUNK_SIZE);

    for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const { sql, extraParamsBefore = [], extraParamsAfter = [] } = sqlBuilder(placeholders);
        const rows = await connection.query(sql, [...extraParamsBefore, ...chunk, ...extraParamsAfter]);
        results.push(...rows);
    }

    return results;
}

/**
 * Obtiene los productos activos (STATUS = 'A') de Empresa 02 (INVE02 + INVE_CLIB02) filtrados por LIN_PROD.
 * @param {Array<string>} lineas
 */
async function obtenerProductosEmpresa02(lineas) {
    return queryEnLotes(db, lineas, (placeholders) => ({
        sql: `
            SELECT
                TRIM(I.CVE_ART) AS CVE_ART,
                TRIM(I.DESCR) AS DESCR,
                TRIM(I.LIN_PROD) AS LIN_PROD,
                I.ULT_COSTO,
                I.FCH_ULTCOM,
                TRIM(C.CAMPLIB24) AS FAMILIA,
                TRIM(C.CAMPLIB13) AS PERFIL,
                TRIM(C.CAMPLIB1) AS DIAM_INT,
                TRIM(C.CAMPLIB2) AS DIAM_EXT,
                TRIM(C.CAMPLIB3) AS ALTURA,
                TRIM(C.CAMPLIB7) AS SECCION,
                TRIM(C.CAMPLIB17) AS SIST_MED
            FROM INVE02 I
            LEFT JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD
            WHERE I.STATUS = 'A'
              AND UPPER(TRIM(I.LIN_PROD)) IN (${placeholders})
        `
    }));
}

/**
 * Obtiene los productos activos (STATUS = 'A') de Empresa 03 (INVE03 + INVE_CLIB03) filtrados por LIN_PROD.
 * En INVE_CLIB03 la familia vive en CAMPLIB29 (fallback si no existiera en Empresa 02).
 * @param {Array<string>} lineas
 */
async function obtenerProductosEmpresa03(lineas) {
    return queryEnLotes(db3, lineas, (placeholders) => ({
        sql: `
            SELECT
                TRIM(I.CVE_ART) AS CVE_ART,
                TRIM(I.DESCR) AS DESCR,
                TRIM(I.LIN_PROD) AS LIN_PROD,
                I.ULT_COSTO,
                I.FCH_ULTCOM,
                TRIM(C.CAMPLIB29) AS FAMILIA,
                TRIM(C.CAMPLIB13) AS PERFIL,
                TRIM(C.CAMPLIB1) AS DIAM_INT,
                TRIM(C.CAMPLIB2) AS DIAM_EXT,
                TRIM(C.CAMPLIB3) AS ALTURA,
                TRIM(C.CAMPLIB7) AS SECCION,
                TRIM(C.CAMPLIB17) AS SIST_MED
            FROM INVE03 I
            LEFT JOIN INVE_CLIB03 C ON I.CVE_ART = C.CVE_PROD
            WHERE I.STATUS = 'A'
              AND UPPER(TRIM(I.LIN_PROD)) IN (${placeholders})
        `
    }));
}

/**
 * Obtiene productos activos (STATUS = 'A') de Empresa 02 (INVE02 + INVE_CLIB02) por arreglo de claves CVE_ART.
 * @param {Array<string>} skus
 */
async function obtenerProductosPorClavesEmp02(skus) {
    return queryEnLotes(db, skus, (placeholders) => ({
        sql: `
            SELECT
                TRIM(I.CVE_ART) AS CVE_ART,
                TRIM(I.DESCR) AS DESCR,
                TRIM(I.LIN_PROD) AS LIN_PROD,
                I.ULT_COSTO,
                I.FCH_ULTCOM,
                TRIM(C.CAMPLIB24) AS FAMILIA,
                TRIM(C.CAMPLIB13) AS PERFIL,
                TRIM(C.CAMPLIB1) AS DIAM_INT,
                TRIM(C.CAMPLIB2) AS DIAM_EXT,
                TRIM(C.CAMPLIB3) AS ALTURA,
                TRIM(C.CAMPLIB7) AS SECCION,
                TRIM(C.CAMPLIB17) AS SIST_MED
            FROM INVE02 I
            LEFT JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD
            WHERE I.STATUS = 'A'
              AND I.CVE_ART IN (${placeholders})
        `
    }));
}

/**
 * Obtiene productos activos (STATUS = 'A') de Empresa 03 (INVE03 + INVE_CLIB03) por arreglo de claves CVE_ART.
 * @param {Array<string>} skus
 */
async function obtenerProductosPorClavesEmp03(skus) {
    return queryEnLotes(db3, skus, (placeholders) => ({
        sql: `
            SELECT
                TRIM(I.CVE_ART) AS CVE_ART,
                TRIM(I.DESCR) AS DESCR,
                TRIM(I.LIN_PROD) AS LIN_PROD,
                I.ULT_COSTO,
                I.FCH_ULTCOM,
                TRIM(C.CAMPLIB29) AS FAMILIA,
                TRIM(C.CAMPLIB13) AS PERFIL,
                TRIM(C.CAMPLIB1) AS DIAM_INT,
                TRIM(C.CAMPLIB2) AS DIAM_EXT,
                TRIM(C.CAMPLIB3) AS ALTURA,
                TRIM(C.CAMPLIB7) AS SECCION,
                TRIM(C.CAMPLIB17) AS SIST_MED
            FROM INVE03 I
            LEFT JOIN INVE_CLIB03 C ON I.CVE_ART = C.CVE_PROD
            WHERE I.STATUS = 'A'
              AND I.CVE_ART IN (${placeholders})
        `
    }));
}

/**
 * Obtiene los datos base de INVE03 (ULT_COSTO, FCH_ULTCOM) por CVE_ART para productos que
 * pudieron haber cambiado de LIN_PROD o existir con distinta línea en Empresa 03.
 * @param {Array<string>} skus
 */
async function obtenerInve03PorClaves(skus) {
    return queryEnLotes(db3, skus, (placeholders) => ({
        sql: `
            SELECT
                TRIM(CVE_ART) AS CVE_ART,
                ULT_COSTO,
                FCH_ULTCOM
            FROM INVE03
            WHERE STATUS = 'A'
              AND CVE_ART IN (${placeholders})
        `
    }));
}

/**
 * Obtiene existencias de almacenes 1 (Durango) y 7 (Querétaro) desde MULT02 (db).
 * @param {Array<string>} skus
 */
async function obtenerExistenciasEmp02(skus) {
    return queryEnLotes(db, skus, (placeholders) => ({
        sql: `
            SELECT
                TRIM(CVE_ART) AS CVE_ART,
                CVE_ALM,
                EXIST
            FROM MULT02
            WHERE CVE_ALM IN (1, 7)
              AND CVE_ART IN (${placeholders})
        `
    }));
}

/**
 * Obtiene existencias de almacenes 3 (Fresnillo), 5 (Mazatlán) y 6 (Zacatecas) desde MULT03 (db3)
 * en una sola lectura global sin cláusula IN (evita degradación del optimizador en db3).
 */
async function obtenerExistenciasEmp03Global() {
    const sql = `
        SELECT
            TRIM(CVE_ART) AS CVE_ART,
            CVE_ALM,
            EXIST
        FROM MULT03
        WHERE CVE_ALM IN (3, 5, 6)
    `;
    return db3.query(sql);
}

/**
 * Obtiene movimientos de compra (CVE_CPTO = 1) ordenados del más reciente al más antiguo (NUM_MOV DESC)
 * sin auto-join para evitar dobles recorridos sobre MINVE02 / MINVE03.
 * @param {object} connection
 * @param {string} tablaMinve 'MINVE02' o 'MINVE03'
 * @param {Array<string>} skus
 */
async function obtenerUltimasComprasMinve(connection, tablaMinve, skus) {
    return queryEnLotes(connection, skus, (placeholders) => ({
        sql: `
            SELECT
                TRIM(CVE_ART) AS CVE_ART,
                TRIM(CLAVE_CLPV) AS CLAVE_CLPV,
                COSTO,
                FECHA_DOCU,
                NUM_MOV
            FROM ${tablaMinve}
            WHERE CVE_CPTO = 1
              AND CVE_ART IN (${placeholders})
            ORDER BY NUM_MOV DESC
        `
    }));
}

/**
 * Obtiene MAX(FECHA_DOC) por artículo y almacén en una sola pasada global sin cláusula IN.
 * @param {object} connection
 * @param {string} tablaDoc 'FACTF02' | 'FACTR02' | 'FACTF03' | 'FACTR03'
 * @param {string} tablaPar 'PAR_FACTF02' | 'PAR_FACTR02' | 'PAR_FACTF03' | 'PAR_FACTR03'
 * @param {string} tipoDoc 'F' | 'R'
 * @param {Array<number>} almacenes
 * @param {string} fechaCorteStr 'YYYY-MM-DD'
 */
async function obtenerMaxFechaVentasGlobal(connection, tablaDoc, tablaPar, tipoDoc, almacenes, fechaCorteStr) {
    const almList = almacenes.join(',');
    const sql = `
        SELECT
            TRIM(P.CVE_ART) AS CVE_ART,
            D.NUM_ALMA,
            MAX(D.FECHA_DOC) AS MAX_FECHA
        FROM ${tablaDoc} D
        INNER JOIN ${tablaPar} P ON D.CVE_DOC = P.CVE_DOC
        WHERE D.TIP_DOC = '${tipoDoc}'
          AND D.STATUS <> 'C'
          AND D.NUM_ALMA IN (${almList})
          AND D.FECHA_DOC >= CAST(? AS DATE)
        GROUP BY 1, 2
    `;
    return connection.query(sql, [fechaCorteStr]);
}

module.exports = {
    obtenerProductosEmpresa02,
    obtenerProductosEmpresa03,
    obtenerProductosPorClavesEmp02,
    obtenerProductosPorClavesEmp03,
    obtenerInve03PorClaves,
    obtenerExistenciasEmp02,
    obtenerExistenciasEmp03Global,
    obtenerUltimasComprasMinve,
    obtenerMaxFechaVentasGlobal
};
