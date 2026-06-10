const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/productos', async (req, res) => {
    console.log("Datos recibidos: ", req.query);
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

        // 1. FILTROS DINÁMICOS AMIGABLES CON ÍNDICES
        let whereClause = "WHERE I.STATUS = 'A'";
        const params = [];

        if (search) {
            whereClause += " AND (I.CVE_ART CONTAINING ? OR I.DESCR CONTAINING ?)";
            params.push(search.trim(), search.trim());
        }

        if (familia) {
            whereClause += " AND C.CAMPLIB24 STARTING WITH ?";
            params.push(familia.trim().toUpperCase());
        } else if (!search) {
            whereClause += " AND C.CAMPLIB24 IS NOT NULL AND C.CAMPLIB24 <> ''";
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

        // 2. CONSULTA PRINCIPAL ALIGERADA
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
                TRIM(C.CAMPLIB16) as "Clave LC"
            FROM INVE02 I
            LEFT JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD
            ${whereClause}
            ORDER BY I.CVE_ART ASC`;

        const finalParams = [...params];
        if (!isDownload) {
            sql += ` ROWS ? TO ?`;
            finalParams.push(offset + 1, offset + pLimit);
        }

        const productos = await db.query(sql, finalParams);

        // 3. TAREA DIVIDIDA: OBTENCIÓN DE CLAVES ALTERNAS EN LOTES
        if (productos.length > 0) {
            const trimmedCves = productos.map(p => p.CVE_ART);
            const alterRecords = [];
            const chunkSize = 1000;

            for (let i = 0; i < trimmedCves.length; i += chunkSize) {
                const chunk = trimmedCves.slice(i, i + chunkSize);
                const placeholders = chunk.map(() => '?').join(',');
                
                // CORRECCIÓN AQUÍ: Aplicamos TRIM(CVE_ART) en el WHERE para que ignore los espacios del VARCHAR
                const alterSql = `
                    SELECT 
                        TRIM(CVE_ART) as "CVE_ART", 
                        TRIM(CVE_CLPV) as "CLPV", 
                        TRIM(CVE_ALTER) as "ALTERNA" 
                    FROM CVES_ALTER02 
                    WHERE TRIM(CVE_ART) IN (${placeholders})
                      AND TRIM(CVE_CLPV) IN ('3', '35')
                `;
                
                const chunkRes = await db.query(alterSql, chunk);
                alterRecords.push(...chunkRes);
            }

            // Inyectamos y mapeamos los resultados en memoria mediante JavaScript
            productos.forEach(p => {
                p["Clave SYR alterna"] = "";
                p["Clave LC alterna"] = "";

                // Ahora que ambos lados de la ecuación sufrieron TRIM(), el match es 100% exacto
                const alts = alterRecords.filter(a => a.CVE_ART === p.CVE_ART);
                alts.forEach(a => {
                    if (a.CLPV === '35') {
                        p["Clave SYR alterna"] = a.ALTERNA;
                    } else if (a.CLPV === '3') {
                        p["Clave LC alterna"] = a.ALTERNA;
                    }
                });
            });
        }

        // 4. CONTEO DE REGISTROS ALIGERADO
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

        console.log("Productos devueltos: ", productos);

        res.json(isDownload ? productos : { 
            total: totalRecords, 
            pag: pPage, 
            limite: pLimit, 
            data: productos 
        });

    } catch (error) {
        console.error("Error en endpoint productos:", error.message);
        res.status(500).json({ error: "Error interno", detalle: error.message });
    }
});

module.exports = router;

