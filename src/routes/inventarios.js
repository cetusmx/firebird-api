const express = require('express');
const router = express.Router();
const db = require('../db');

/* router.get('/productos', async (req, res) => {
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

        // 1. FILTROS
        let whereClause = "WHERE I.STATUS = 'A' AND C.CAMPLIB24 IS NOT NULL AND C.CAMPLIB24 <> ''";
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
        if (familia) {
            whereClause += " AND C.CAMPLIB24 STARTING WITH ?";
            params.push(familia.trim().toUpperCase());
        }
        if (perfil) {
            whereClause += " AND C.CAMPLIB13 STARTING WITH ?";
            params.push(perfil.trim().toUpperCase());
        }
        if (genero) {
            whereClause += " AND C.CAMPLIB21 STARTING WITH ?";
            params.push(genero.trim().toUpperCase());
        }

        // 2. CONSULTA SQL CORREGIDA
        // La clave aquí es el TRIM en el campo CVE_CLPV para ignorar espacios a izq o der.
        let sql = `
            SELECT 
                TRIM(I.CVE_ART) as "CVE_ART", 
                TRIM(I.DESCR) as "DESCR", 
                TRIM(I.LIN_PROD) as "LIN_PROD", 
                TRIM(I.UNI_MED) as "UNI_MED", 
                I.FCH_ULTCOM, I.ULT_COSTO, I.EXIST,
                TRIM(C.CAMPLIB1) as "Diámetro Interior",
                TRIM(C.CAMPLIB2) as "Diámetro Exterior",
                TRIM(C.CAMPLIB3) as "Altura",
                TRIM(C.CAMPLIB13) as "Perfil",
                TRIM(C.CAMPLIB21) as "Genero",
                TRIM(C.CAMPLIB24) as "Familia",
                TRIM(C.CAMPLIB15) as "Clave SYR", 
                TRIM(C.CAMPLIB16) as "Clave LC",
                TRIM(A1.CVE_ALTER) as "Clave SYR alterna",
                TRIM(A2.CVE_ALTER) as "Clave LC alterna"
            FROM INVE02 I
            INNER JOIN INVE_CLIB02 C ON TRIM(C.CVE_PROD) = TRIM(I.CVE_ART)
            LEFT JOIN CVES_ALTER02 A1 ON TRIM(A1.CVE_ART) = TRIM(I.CVE_ART) AND (TRIM(A1.CVE_CLPV) = '35' OR A1.CVE_CLPV = '35')
            LEFT JOIN CVES_ALTER02 A2 ON TRIM(A2.CVE_ART) = TRIM(I.CVE_ART) AND (TRIM(A2.CVE_CLPV) = '3' OR A2.CVE_CLPV = '3')
            ${whereClause}
            ORDER BY I.CVE_ART ASC`;

        const finalParams = [...params];
        if (!isDownload) {
            sql += ` ROWS ? TO ?`;
            finalParams.push(offset + 1, offset + pLimit);
        }

        const productos = await db.query(sql, finalParams);

        // 3. CONTEO (Igualamos la lógica de Joins)
        let totalRecords = 0;
        if (!isDownload) {
            const countSql = `
                SELECT COUNT(*) as TOTAL 
                FROM INVE02 I 
                INNER JOIN INVE_CLIB02 C ON TRIM(C.CVE_PROD) = TRIM(I.CVE_ART)
                ${whereClause}`;
            const countRes = await db.query(countSql, params);
            totalRecords = countRes[0].TOTAL;
        }

        res.json(isDownload ? productos : { total: totalRecords, pag: pPage, limite: pLimit, data: productos });

    } catch (error) {
        console.error("Error en endpoint productos:", error.message);
        res.status(500).json({ error: "Error interno", detalle: error.message });
    }
}); */

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

        // 1. FILTROS CON CAST DE SEGURIDAD
        // Forzamos a que los campos sean tratados como VARCHAR para evitar el error -303
        let whereClause = "WHERE I.STATUS = 'A' AND C.CAMPLIB24 IS NOT NULL";
        const params = [];

        if (search) {
            // Aplicamos CAST a VARCHAR para que el LIKE no truene con claves largas
            whereClause += ` AND (
                CAST(I.CVE_ART AS VARCHAR(100)) LIKE ? OR 
                CAST(I.DESCR AS VARCHAR(255)) LIKE ?
            )`;
            const s = `%${search.toUpperCase().trim()}%`;
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
            whereClause += " AND C.CAMPLIB24 STARTING WITH ?";
            params.push(familia.trim().toUpperCase());
        }

        // 2. CONSULTA PRINCIPAL
        // Mantenemos los JOINs lo más simples posible (sin TRIM ni CAST en el ON)
        // Firebird maneja bien el cruce de CHAR(20) vs CHAR(20) de forma nativa.
        let sql = `
            SELECT 
                TRIM(I.CVE_ART) as "CVE_ART", 
                TRIM(I.DESCR) as "DESCR", 
                TRIM(I.LIN_PROD) as "LIN_PROD", 
                TRIM(I.UNI_MED) as "UNI_MED", 
                I.FCH_ULTCOM, I.ULT_COSTO, I.EXIST,
                TRIM(C.CAMPLIB1) as "Diámetro Interior",
                TRIM(C.CAMPLIB2) as "Diámetro Exterior",
                TRIM(C.CAMPLIB3) as "Altura",
                TRIM(C.CAMPLIB13) as "Perfil",
                TRIM(C.CAMPLIB21) as "Genero",
                TRIM(C.CAMPLIB24) as "Familia",
                TRIM(C.CAMPLIB15) as "Clave SYR", 
                TRIM(C.CAMPLIB16) as "Clave LC",
                TRIM(A1.CVE_ALTER) as "Clave SYR alterna",
                TRIM(A2.CVE_ALTER) as "Clave LC alterna"
            FROM INVE02 I
            INNER JOIN INVE_CLIB02 C ON C.CVE_PROD = I.CVE_ART
            LEFT JOIN CVES_ALTER02 A1 ON A1.CVE_ART = I.CVE_ART AND A1.CVE_CLPV STARTING WITH '35'
            LEFT JOIN CVES_ALTER02 A2 ON A2.CVE_ART = I.CVE_ART AND A2.CVE_CLPV STARTING WITH '3'
            ${whereClause}
            ORDER BY I.CVE_ART ASC`;

        const finalParams = [...params];
        if (!isDownload) {
            sql += ` ROWS ? TO ?`;
            finalParams.push(offset + 1, offset + pLimit);
        }

        const productos = await db.query(sql, finalParams);

        // 3. CONTEO (También con CAST para evitar que el COUNT falle)
        let totalRecords = 0;
        if (!isDownload) {
            const countSql = `
                SELECT COUNT(*) as TOTAL 
                FROM INVE02 I 
                INNER JOIN INVE_CLIB02 C ON C.CVE_PROD = I.CVE_ART
                ${whereClause}`;
            const countRes = await db.query(countSql, params);
            totalRecords = countRes[0].TOTAL;
        }

        res.json(isDownload ? productos : { 
            total: totalRecords, 
            pag: pPage, 
            limite: pLimit, 
            data: productos 
        });

    } catch (error) {
        console.error("Error detectado:", error.message);
        res.status(500).json({ 
            error: "Error en la consulta Firebird", 
            detalle: error.message 
        });
    }
});


module.exports = router;