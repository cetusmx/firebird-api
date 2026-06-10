const express = require('express');
const router = express.Router();
const db = require('../db'); // Conexión a Empresa 2 (tablas 02)

/**
 * POST /api/dashboard-inventarios/asertividad-ciclico
 * Evalúa las discrepancias de un lote de productos para un inventario en proceso.
 */
router.post('/asertividad-ciclico', async (req, res) => {
    try {
        const { refer, productos } = req.body;

        // Validaciones iniciales de la petición
        if (!refer || !productos || !Array.isArray(productos)) {
            return res.status(400).json({ 
                error: "Los parámetros 'refer' (string) y 'productos' (array de strings) son requeridos en el body." 
            });
        }

        if (productos.length === 0) {
            return res.json([]);
        }

        // 1. Limpieza de las claves enviadas para evitar fallos por espacios invisibles
        const cleanedClaves = productos.map(p => String(p).trim());
        
        const dbResults = [];
        const chunkSize = 1000; // Procesamos en bloques de 1,000 para respetar los límites de Firebird

        // 2. Procesamiento por sub-lotes
        for (let i = 0; i < cleanedClaves.length; i += chunkSize) {
            const chunk = cleanedClaves.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');

            // Nota la lógica: Iniciamos en INVE_CLIB02 para asegurar traer datos libres 
            // aunque el producto NO tenga filas en MINVE02 con ese REFER.
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

            // El primer parámetro es el ID del inventario (REFER), seguido de los códigos del bloque
            const queryParams = [refer.trim(), ...chunk];
            const chunkRes = await db.query(sql, queryParams);
            dbResults.push(...chunkRes);
        }

        // 3. Mapeo final en memoria para estructurar la respuesta exacta
        // Esto garantiza que se devuelvan los 3,000 productos en el mismo orden que llegaron
        const respuestaFinal = cleanedClaves.map(clave => {
            // Buscamos si la base de datos retornó registros para esta clave
            const registroBd = dbResults.find(r => r.CVE_ART === clave);

            // Si se encontró en la BD y posee un campo REFER, significa que el LEFT JOIN hizo match en MINVE02
            if (registroBd && registroBd.REFER) {
                let resultadoTxt = "SIN CAMBIO";
                const cpto = parseInt(registroBd.CVE_CPTO, 10);
                
                if (cpto === 10) resultadoTxt = "AJUSTE";
                if (cpto === 60) resultadoTxt = "MERMA";

                return {
                    CVE_ART: registroBd.CVE_ART,
                    REFER: registroBd.REFER,
                    CVE_CPTO: registroBd.CVE_CPTO,
                    COSTO: registroBd.COSTO,
                    CANT: registroBd.CANT,
                    FAMILIA: registroBd.FAMILIA || "",
                    GENERO: registroBd.GENERO || "",
                    CATEGORIA: registroBd.CATEGORIA || "",
                    RESULTADO: resultadoTxt
                };
            } else {
                // Si registroBd existe pero REFER es null (o si el producto no existe en el catálogo), es un SIN CAMBIO
                return {
                    CVE_ART: clave,
                    REFER: "",
                    CVE_CPTO: null,
                    COSTO: null,
                    CANT: null,
                    FAMILIA: registroBd ? (registroBd.FAMILIA || "") : "",
                    GENERO: registroBd ? (registroBd.GENERO || "") : "",
                    CATEGORIA: registroBd ? (registroBd.CATEGORIA || "") : "",
                    RESULTADO: "SIN CAMBIO"
                };
            }
        });

        // 4. Retorno de los datos tabulados al Frontend
        res.json(respuestaFinal);

    } catch (error) {
        console.error("Error en endpoint asertividad-ciclico:", error.message);
        res.status(500).json({ error: "Error interno del servidor", detalle: error.message });
    }
});

module.exports = router;