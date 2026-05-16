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
            // CONTAINING busca subcadenas sin romper la estabilidad del buffer
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
        // Eliminamos por completo los JOINS con CVES_ALTER02 de aquí para evitar el freeze.
        // Conservamos "RAW_CVE" (la clave original con espacios) para cruzarla en el paso 3 de forma exacta.
        let sql = `
            SELECT 
                I.CVE_ART as "RAW_CVE",
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

        // Esta consulta ahora se ejecuta de inmediato
        const productos = await db.query(sql, finalParams);

        // 3. TAREA DIVIDIDA: OBTENCIÓN DE CLAVES ALTERNAS EN LOTES
        // Solo buscamos las claves alternas de los productos que realmente se van a mostrar (10, 50 o los del download)
        if (productos.length > 0) {
            const rawCves = productos.map(p => p.RAW_CVE);
            const alterRecords = [];
            const chunkSize = 1000; // Firebird tiene un límite nativo de 1500 elementos en expresiones IN (...)

            // Segmentamos en bloques por si se trata de una descarga masiva completa
            for (let i = 0; i < rawCves.length; i += chunkSize) {
                const chunk = rawCves.slice(i, i + chunkSize);
                const placeholders = chunk.map(() => '?').join(',');
                
                // Al buscar de manera directa "CVE_ART IN (...)" con los strings exactos de la BD,
                // Firebird utiliza el índice primario al 100% respondiendo en menos de 5ms.
                const alterSql = `
                    SELECT 
                        CVE_ART, 
                        TRIM(CVE_CLPV) as CLPV, 
                        TRIM(CVE_ALTER) as ALTERNA 
                    FROM CVES_ALTER02 
                    WHERE CVE_ART IN (${placeholders})
                      AND (CVE_CLPV STARTING WITH '35' OR CVE_CLPV STARTING WITH '3')
                `;
                
                const chunkRes = await db.query(alterSql, chunk);
                alterRecords.push(...chunkRes);
            }

            // Inyectamos y mapeamos los resultados en memoria mediante JavaScript
            productos.forEach(p => {
                p["Clave SYR alterna"] = "";
                p["Clave LC alterna"] = "";

                // Buscamos coincidencia exacta de strings binarios con la tabla secundaria
                const alts = alterRecords.filter(a => a.CVE_ART === p.RAW_CVE);
                alts.forEach(a => {
                    if (a.CLPV === '35') {
                        p["Clave SYR alterna"] = a.ALTERNA;
                    } else if (a.CLPV === '3') {
                        p["Clave LC alterna"] = a.ALTERNA;
                    }
                });

                // Limpieza: Removemos la columna temporal interna para no mandarla al frontend
                delete p.RAW_CVE;
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