const express = require('express');
const router = express.Router();
const db = require('../db');

/**
 * GET /api/productos
 * Catálogo de productos con filtros, paginación y opción de descarga.
 */
router.get('/productos', async (req, res) => {
    try {
        const { 
            page, limit, search, 
            linea, perfil, genero, familia, 
            download 
        } = req.query;

        const isDownload = download === 'true';
        const pPage = parseInt(page) || 1;
        const pLimit = parseInt(limit) || 50;
        const offset = (pPage - 1) * pLimit;

        // 1. CONSTRUCCIÓN DINÁMICA DE FILTROS
        // Usamos STARTING WITH en lugar de TRIM para aprovechar índices y evitar que se cuelgue
        let whereClause = "WHERE I.STATUS = 'A'";
        const params = [];

        if (search) {
            whereClause += " AND (I.CVE_ART LIKE ? OR I.DESCR LIKE ?)";
            const s = `%${search.toUpperCase()}%`;
            params.push(s, s);
        }
        
        if (linea) {
            whereClause += " AND I.LIN_PROD STARTING WITH ?";
            params.push(linea.trim().toUpperCase());
        }

        if (perfil) {
            whereClause += " AND C.CAMPLIB13 STARTING WITH ?";
            params.push(perfil.trim().toUpperCase());
        }

        if (genero) {
            whereClause += " AND C.CAMPLIB21 STARTING WITH ?";
            params.push(genero.trim().toUpperCase());
        }

        if (familia) {
            // CORRECCIÓN: Se cambió de CAMPLIB22 a CAMPLIB24
            whereClause += " AND C.CAMPLIB24 STARTING WITH ?";
            params.push(familia.trim().toUpperCase());
        }

        // 2. OBTENER TOTAL DE REGISTROS (Solo si no es descarga)
        let totalRecords = 0;
        if (!isDownload) {
            const countSql = `
                SELECT COUNT(*) as TOTAL 
                FROM INVE02 I 
                LEFT JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD 
                ${whereClause}`;
            const countRes = await db.query(countSql, params);
            totalRecords = countRes[0].TOTAL;
        }

        // 3. CONSULTA PRINCIPAL
        // Se eliminan TRIMs innecesarios de los JOINs para máxima velocidad
        let sql = `
            SELECT 
                TRIM(I.CVE_ART) as "CVE_ART", 
                TRIM(I.DESCR) as "DESCR", 
                TRIM(I.LIN_PROD) as "LIN_PROD", 
                TRIM(I.UNI_MED) as "UNI_MED", 
                I.FCH_ULTCOM, 
                I.ULT_COSTO, 
                I.EXIST,
                TRIM(C.CAMPLIB13) as "Perfil",
                TRIM(C.CAMPLIB21) as "Genero",
                TRIM(C.CAMPLIB24) as "Familia",
                TRIM(C.CAMPLIB15) as "Clave SYR", 
                TRIM(C.CAMPLIB16) as "Clave LC",
                TRIM(A1.CVE_ALTER) as "Clave SYR alterna",
                TRIM(A2.CVE_ALTER) as "Clave LC alterna"
            FROM INVE02 I
            LEFT JOIN INVE_CLIB02 C ON C.CVE_PROD = I.CVE_ART
            LEFT JOIN CVES_ALTER02 A1 ON A1.CVE_ART = I.CVE_ART AND A1.CVE_CLPV = '35'
            LEFT JOIN CVES_ALTER02 A2 ON A2.CVE_ART = I.CVE_ART AND A2.CVE_CLPV = '3'
            ${whereClause}
            ORDER BY I.CVE_ART ASC`;

        // Aplicar paginación si no es descarga
        const finalParams = [...params];
        if (!isDownload) {
            sql += ` ROWS ? TO ?`;
            finalParams.push(offset + 1, offset + pLimit);
        }

        const productos = await db.query(sql, finalParams);

        // 4. ENVÍO DE RESPUESTA
        if (isDownload) {
            // Formato de arreglo simple para Excel/CSV
            res.json(productos);
        } else {
            // Formato estructurado para Grid con paginación
            res.json({
                total: totalRecords,
                pag: pPage,
                limite: pLimit,
                data: productos
            });
        }

    } catch (error) {
        console.error("Error en catálogo de productos:", error.message);
        res.status(500).json({ 
            error: "Error interno del servidor", 
            detalle: error.message 
        });
    }
});

module.exports = router;