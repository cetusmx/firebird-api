const express = require('express');
const router = express.Router();
const db = require('../db'); // Conexión a Empresa 2 (sufijo 02)

/**
 * GET /api/almacenes
 * Retorna el catálogo de almacenes activos con formato para DropDownList.
 */
router.get('/almacenes', async (req, res) => {
    try {
        // Usamos alias (as) para mapear CVE_ALM a "id" y DESCR a "nombre"
        const sql = `
            SELECT 
                CVE_ALM as "id", 
                TRIM(DESCR) as "nombre" 
            FROM ALMACENES02 
            WHERE STATUS = 'A' 
            ORDER BY CVE_ALM ASC`;

        const almacenes = await db.query(sql);

        // Al usar alias en el SQL, el arreglo resultante ya viene con el formato deseado
        res.json(almacenes);

    } catch (error) {
        console.error("Error al obtener almacenes:", error.message);
        res.status(500).json({ 
            error: "Error al obtener el catálogo de almacenes", 
            detalle: error.message 
        });
    }
});

/**
 * GET /api/catalogos/jerarquia
 * Retorna las líneas y sus perfiles asociados filtrados por una familia específica (CAMPLIB24)
 * y opcionalmente acotado por su sistema de medición (CAMPLIB17).
 * * Ejemplo de llamada: /api/catalogos/jerarquia?familia=LIMPIADORES&sist_med=MM
 */
router.get('/jerarquia', async (req, res) => {
    const { familia, sist_med } = req.query;

    if (!familia) {
        return res.status(400).json({ 
            error: "Parámetro requerido", 
            detalle: "Debes proporcionar el parámetro 'familia' en la consulta." 
        });
    }

    const limpioFamilia = familia.trim().toUpperCase();

    // Consulta base uniendo inventario y campos libres apuntando a la familia activa (CAMPLIB24)
    let sql = `
        SELECT DISTINCT
            TRIM(I.LIN_PROD) as "LINEA",
            TRIM(C.CAMPLIB13) as "PERFIL"
        FROM INVE02 I
        INNER JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD
        WHERE I.STATUS = 'A'
          AND UPPER(TRIM(C.CAMPLIB24)) = CAST(? AS VARCHAR(100))
          AND I.LIN_PROD IS NOT NULL 
          AND TRIM(I.LIN_PROD) <> ''
          AND C.CAMPLIB13 IS NOT NULL 
          AND TRIM(C.CAMPLIB13) <> ''
    `;

    const params = [limpioFamilia];

    // CORRECCIÓN/MEJORA: Si se proporciona el sistema de medición, inyectamos el filtro de CAMPLIB17
    if (sist_med) {
        sql += ` AND UPPER(TRIM(C.CAMPLIB17)) = CAST(? AS VARCHAR(50)) `;
        params.push(sist_med.trim().toUpperCase());
    }

    // Cerramos el ordenamiento reglamentario
    sql += ` ORDER BY "LINEA" ASC, "PERFIL" ASC `;

    try {
        const rows = await db.query(sql, params);

        const lineasMap = {};

        rows.forEach(row => {
            const linea = row.LINEA;
            const perfil = row.PERFIL;

            if (!lineasMap[linea]) {
                lineasMap[linea] = [];
            }
            if (!lineasMap[linea].includes(perfil)) {
                lineasMap[linea].push(perfil);
            }
        });

        const resultadoJerarquia = Object.entries(lineasMap).map(([linea, perfiles]) => ({
            linea,
            perfiles
        }));

        res.json(resultadoJerarquia);

    } catch (error) {
        console.error("Error al obtener la jerarquía de catálogos:", error.message);
        res.status(500).json({
            error: "Error interno del servidor al procesar la jerarquía",
            detalle: error.message
        });
    }
});

module.exports = router;