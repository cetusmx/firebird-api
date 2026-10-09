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

        //console.log("Productos devueltos: ", productos);

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

router.post('/productos/consulta', async (req, res) => {
    try {
        const { claves } = req.body;

        // 1. Validar el input
        if (!Array.isArray(claves) || claves.length === 0) {
            return res.status(400).json({ 
                error: 'El formato esperado es { "claves": ["clave1", "clave2"] } con al menos un elemento.' 
            });
        }

        // 2. Limpiar las claves recibidas (eliminar espacios y nulos)
        const clavesLimpias = claves
            .filter(c => typeof c === 'string' && c.trim() !== '')
            .map(c => c.trim());
        
        if (clavesLimpias.length === 0) {
            return res.status(400).json({ error: 'El arreglo "claves" no contiene datos válidos.' });
        }

        // 3. Procesar en lotes (chunks) para prevenir límites de Firebird en cláusulas IN (máx ~1500 params)
        const chunkSize = 1000;
        const productosEncontrados = [];

        for (let i = 0; i < clavesLimpias.length; i += chunkSize) {
            const chunk = clavesLimpias.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');

            // Consulta solicitando únicamente los datos necesarios y alias exactos (entre comillas dobles para respetar minúsculas)
            const sql = `
                SELECT 
                    TRIM(CVE_ART) AS "clave", 
                    TRIM(DESCR) AS "descripcion", 
                    TRIM(LIN_PROD) AS "linea", 
                    TRIM(UNI_MED) AS "unidad"
                FROM INVE02 
                WHERE STATUS = 'A' AND TRIM(CVE_ART) IN (${placeholders})
            `;

            const chunkRes = await db.query(sql, chunk);
            productosEncontrados.push(...chunkRes);
        }

        // 4. Devolver la respuesta en el formato exacto esperado
        res.json({ productos: productosEncontrados });

    } catch (error) {
        console.error("Error en endpoint POST /productos/consulta:", error.message);
        res.status(500).json({ error: "Error interno al procesar la solicitud.", detalle: error.message });
    }
});

router.post('/productos-recepcion', async (req, res) => {
    try {
        const { rfc, claves_proveedor } = req.body;

        if (!rfc || !Array.isArray(claves_proveedor) || claves_proveedor.length === 0) {
            return res.status(400).json({ error: 'Se requiere "rfc" y un arreglo "claves_proveedor" con al menos un elemento.' });
        }

        const clavesLimpias = claves_proveedor
            .filter(c => typeof c === 'string' && c.trim() !== '')
            .map(c => c.trim());

        if (clavesLimpias.length === 0) {
            return res.status(400).json({ error: 'El arreglo "claves_proveedor" no contiene datos válidos.' });
        }

        let campoPrincipal = "";
        let clpvAlterno = "";

        if (rfc === 'CSM030620TJ2') {
            // Proveedor LC
            campoPrincipal = 'C.CAMPLIB16';
            clpvAlterno = '3';
        } else if (rfc === 'SRS080522T77') {
            // Proveedor SYR
            campoPrincipal = 'C.CAMPLIB15';
            clpvAlterno = '35';
        } else {
            return res.status(400).json({ error: 'RFC no soportado para esta operación.' });
        }

        // Dividir claves a buscar en chunks de 1000 para evitar errores de Firebird en cláusulas IN
        const chunkSize = 1000;
        let registrosEncontrados = [];

        for (let i = 0; i < clavesLimpias.length; i += chunkSize) {
            const chunk = clavesLimpias.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');

            // Buscamos productos donde coincida la clave ya sea en el principal o en la alterna.
            const sql = `
                SELECT 
                    TRIM(I.CVE_ART) AS CVE_ART,
                    TRIM(${campoPrincipal}) AS CLAVE_PRINCIPAL,
                    TRIM(A.CVE_ALTER) AS CLAVE_ALTERNA
                FROM INVE02 I
                LEFT JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD
                LEFT JOIN CVES_ALTER02 A ON I.CVE_ART = A.CVE_ART AND TRIM(A.CVE_CLPV) = '${clpvAlterno}'
                WHERE I.STATUS = 'A' AND (
                    TRIM(${campoPrincipal}) IN (${placeholders})
                    OR TRIM(A.CVE_ALTER) IN (${placeholders})
                )
            `;

            // Al enviar chunk + chunk, llenamos los dos IN (...)
            const chunkRes = await db.query(sql, [...chunk, ...chunk]);
            registrosEncontrados.push(...chunkRes);
        }

        // Construir resultado final
        const resultados = clavesLimpias.map(claveReq => {
            let nuestraClave = "SIN REGISTRO";

            // Buscar en los registros cuál empataría como "efectivo" para esta claveReq
            const match = registrosEncontrados.find(row => {
                let claveEfectiva = "";
                if (row.CLAVE_PRINCIPAL && row.CLAVE_PRINCIPAL !== "FUERA CATALOGO") {
                    claveEfectiva = row.CLAVE_PRINCIPAL;
                } else if (row.CLAVE_ALTERNA && row.CLAVE_ALTERNA !== "FUERA CATALOGO") {
                    claveEfectiva = row.CLAVE_ALTERNA;
                } else {
                    claveEfectiva = "FUERA CATALOGO";
                }
                return claveEfectiva === claveReq;
            });

            if (match) {
                nuestraClave = match.CVE_ART;
            }

            return {
                clave_proveedor: claveReq,
                nuestra_clave: nuestraClave
            };
        });

        res.json({ resultados });

    } catch (error) {
        console.error("Error en endpoint POST /productos-recepcion:", error.message);
        res.status(500).json({ error: "Error interno al buscar claves.", detalle: error.message });
    }
});

module.exports = router;

