const express = require('express');
const router = express.Router();
const db = require('../db');

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

        // 1. Construcción dinámica de filtros
        let whereClause = "WHERE I.STATUS = 'A'";
        const params = [];

        if (search) {
            whereClause += " AND (I.CVE_ART LIKE ? OR I.DESCR LIKE ?)";
            const s = `%${search.toUpperCase()}%`;
            params.push(s, s);
        }
        if (linea) {
            whereClause += " AND TRIM(I.LIN_PROD) = ?";
            params.push(linea.trim());
        }
        if (perfil) {
            whereClause += " AND TRIM(C.CAMPLIB13) = ?";
            params.push(perfil.trim());
        }
        if (genero) {
            whereClause += " AND TRIM(C.CAMPLIB21) = ?";
            params.push(genero.trim());
        }
        if (familia) {
            whereClause += " AND TRIM(C.CAMPLIB22) = ?";
            params.push(familia.trim());
        }

        // 2. Obtener Total (Solo si no es descarga)
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

        // 3. Consulta Principal
        // Si es descarga, no usamos ROWS (paginación)
        let sql = `
            SELECT 
                TRIM(I.CVE_ART) as "CVE_ART", 
                TRIM(I.DESCR) as "DESCR", 
                TRIM(I.LIN_PROD) as "LIN_PROD", 
                TRIM(I.UNI_MED) as "UNI_MED", 
                I.FCH_ULTCOM, I.ULT_COSTO, I.EXIST,
                TRIM(C.CAMPLIB13) as "Perfil",
                TRIM(C.CAMPLIB21) as "Genero",
                TRIM(C.CAMPLIB22) as "Familia",
                TRIM(C.CAMPLIB15) as "Clave SYR", 
                TRIM(C.CAMPLIB16) as "Clave LC",
                TRIM(A1.CVE_ALTER) as "Clave SYR alterna",
                TRIM(A2.CVE_ALTER) as "Clave LC alterna"
            FROM INVE02 I
            LEFT JOIN INVE_CLIB02 C ON TRIM(C.CVE_PROD) = TRIM(I.CVE_ART)
            LEFT JOIN CVES_ALTER02 A1 ON TRIM(A1.CVE_ART) = TRIM(I.CVE_ART) AND TRIM(A1.CVE_CLPV) = '35'
            LEFT JOIN CVES_ALTER02 A2 ON TRIM(A2.CVE_ART) = TRIM(I.CVE_ART) AND TRIM(A2.CVE_CLPV) = '3'
            ${whereClause}
            ORDER BY I.CVE_ART ASC`;

        if (!isDownload) {
            sql += ` ROWS ? TO ?`;
            params.push(offset + 1, offset + pLimit);
        }

        const productos = await db.query(sql, params);

        // 4. Respuesta estructurada
        if (isDownload) {
            res.json(productos); // Solo el arreglo plano para la descarga
        } else {
            res.json({
                total: totalRecords,
                pag: pPage,
                limite: pLimit,
                data: productos
            });
        }

    } catch (error) {
        console.error("Error en catálogo:", error.message);
        res.status(500).json({ error: "Error interno", detalle: error.message });
    }
});

module.exports = router;