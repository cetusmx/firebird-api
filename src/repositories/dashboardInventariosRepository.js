const db = require('../db'); // Conexión a Empresa 2

/**
 * Consulta a Firebird los movimientos de inventario (MINVE02) y catálogos (INVE_CLIB02)
 * dividiendo las claves en bloques para respetar los límites de la base de datos.
 */
const obtenerMovimientosYClasificacion = async (refer, productos) => {
    const dbResults = [];
    const chunkSize = 200;
    
    // Limpieza de espacios para evitar fallos de strings binarios en Firebird
    const cleanedClaves = productos.map(p => String(p).trim());

    for (let i = 0; i < cleanedClaves.length; i += chunkSize) {
        const chunk = cleanedClaves.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');

        const sql = `
            SELECT 
                TRIM(C.CVE_PROD) as "CVE_ART",
                TRIM(M.REFER) as "REFER",
                M.CVE_CPTO as "CVE_CPTO",
                M.COSTO as "COSTO",
                M.CANT as "CANT",
                TRIM(C.CAMPLIB22) as "FAMILIA",
                TRIM(C.CAMPLIB21) as "GENERO",
                TRIM(C.CAMPLIB24) as "CATEGORIA"
            FROM INVE_CLIB02 C
            LEFT JOIN MINVE02 M ON M.CVE_ART = C.CVE_PROD 
                                AND TRIM(M.REFER) = ? 
                                AND M.CVE_CPTO IN (10, 60)
            WHERE C.CVE_PROD IN (${placeholders})
        `;

        const queryParams = [refer.trim(), ...chunk];
        const chunkRes = await db.query(sql, queryParams);
        dbResults.push(...chunkRes);
    }

    return dbResults;
};

module.exports = {
    obtenerMovimientosYClasificacion
};